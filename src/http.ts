import * as net from 'net';
import * as http from 'http';

/**
 * Host names this server answers to. Both servers listen on 127.0.0.1 only, so anything
 * else in a Host header means the request arrived under a name that is not ours — which
 * is what a DNS-rebinding attack looks like from the inside.
 *
 * No IPv6 entries: a connection to ::1 cannot reach a socket bound to 127.0.0.1, so they
 * would be unreachable lines that read as coverage this code does not have.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * The one host we dial *out* to. Narrower than LOOPBACK_HOSTS on purpose: accepting
 * `localhost` inbound is right (that is how a caller may address us), but using it outbound
 * is not — with Node's verbatim DNS ordering it resolves to ::1 first on a dual-stack machine,
 * and per the note above, ::1 cannot reach a socket bound to 127.0.0.1. A satellite registered
 * as http://localhost:27692 would then fail every forwarded call with ECONNREFUSED.
 */
const AGENT_HOST = '127.0.0.1';

/**
 * Headers for a Server-Sent Events response.
 *
 * MCP's streamable-HTTP transport answers a request with either a single JSON object or an
 * SSE stream; these are the headers for the streaming case.
 */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  // Tells reverse proxies not to buffer the response. Without it a proxy may hold frames back
  // until it has a bufferful, which defeats the point of streaming progress.
  'X-Accel-Buffering': 'no',
} as const;

/** Write one SSE frame: `data: <json>\n\n`. */
export function sseWrite(res: http.ServerResponse, payload: unknown): boolean {
  return res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Guard an SSE writer against backpressure: drop frames while a slow reader is catching up,
 * rather than buffering them in memory.
 *
 * Four call sites (two in this file's callers, two in agentServer.ts) hand-rolled the same
 * paused/drain dance around sseWrite. One writer per stream, reused across every frame it sends.
 */
export function guardedSseWrite(res: http.ServerResponse): (payload: unknown) => boolean {
  let paused = false;
  return (payload: unknown): boolean => {
    if (paused) return false;
    if (!sseWrite(res, payload)) {
      paused = true;
      res.once('drain', () => { paused = false; });
      return false;
    }
    return true;
  };
}

/** `Math.min(base * 2^attempt, cap)` — the reconnect/retry backoff shape used in a few places,
 * each with its own base and cap. */
export function exponentialBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** attempt, capMs);
}

/** Collapse whitespace and truncate with an ellipsis, so a value cannot span rows in
 * line-oriented output or blow up a log line. */
export function oneLine(s: string, max = 200): string {
  // JSON.stringify(undefined) evaluates to the runtime value `undefined`, not the string
  // "undefined" (a gap between its TS typing and its real behavior) — a caller passing that
  // straight through as `s` would otherwise crash this function's own error-message path on
  // `.replace`, replacing a clear message with a confusing secondary TypeError.
  if (typeof s !== 'string') return String(s);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Normalize a free-form label (a workspace folder name, say) into one safe field: no control
 * characters, no quotes, collapsed whitespace, bounded length, no ellipsis (it is an identifier,
 * not prose — a trailing "…" could make two different long names collide).
 *
 * Used for both a hub's own session id and a satellite's, so the two cannot drift into
 * accepting different characters for what has to be the same field.
 */
export function sanitizeLabel(raw: string, max = 200): string {
  const safe = raw.replace(/[\x00-\x1f"]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (safe.length > max ? safe.slice(0, max) : safe) || 'default';
}

/**
 * Write an SSE comment as a keep-alive.
 *
 * Any line starting with a colon is a comment the client must ignore. On a long-lived stream
 * this is what stops an idle connection from being dropped by a proxy or a client timeout
 * during a quiet stretch — a build that prints nothing for a minute, say.
 */
export function sseComment(res: http.ServerResponse): boolean {
  return res.write(':\r\n\r\n');
}

/**
 * Keep a stream alive and tear the timer down exactly once.
 *
 * The timer has to be cleared on *both* paths — the client vanishing and the response ending
 * normally. Miss either and a stray interval keeps writing into a dead response every 15s for
 * the life of the extension host.
 */
export function startKeepAlive(res: http.ServerResponse, intervalMs = 15000): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    sseComment(res);
  }, intervalMs);
  timer.unref?.();
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  res.on('close', stop);
  return stop;
}

/**
 * Normalize an agent URL, or return null if it is not one this hub may forward to.
 *
 * The hub forwards tool calls — command text, file paths, terminal output — to whatever
 * agentUrl a session registered under. Without this check any local process can register a
 * remote URL and have that traffic delivered to it, so the outbound side needs the same
 * loopback rule the inbound guard applies.
 */
export function normalizeAgentUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return null;
    if (url.port === '') return null;
    if (url.hostname.toLowerCase() !== AGENT_HOST) return null;
    // Return the origin, not the input. A trailing slash would make forwardToAgent build
    // "…:27691//tool", which misses the agent server's exact-match route and comes back as a
    // bodyless 404; a missing port would reach http.request as NaN and throw ERR_SOCKET_BAD_PORT
    // on every forwarded call. Storing the normalized form keeps both out of the registry.
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Log a rejection, rate-limited.
 *
 * The message quotes the caller's own Host or Origin, so an unattended page looping requests
 * against the port would otherwise write a line per request into the extension host log for
 * as long as it likes. One line per second is enough to notice a misconfigured client, which
 * is what this log is for; the guard itself does not depend on it.
 */
const LOG_INTERVAL_MS = 1000;
let lastLoggedAt = 0;
let suppressed = 0;

function logRejection(message: string): void {
  const now = Date.now();
  if (now - lastLoggedAt < LOG_INTERVAL_MS) {
    suppressed++;
    return;
  }
  lastLoggedAt = now;
  const trimmed = message.length > 200 ? `${message.slice(0, 200)}…` : message;
  const tail = suppressed > 0 ? ` (${suppressed} further rejections suppressed)` : '';
  suppressed = 0;
  console.warn(`[pylon] rejected request: ${trimmed}${tail}`);
}

export function rejectRequest(
  res: http.ServerResponse,
  status: number,
  message: string,
  headers: http.OutgoingHttpHeaders = {},
): true {
  // A plain {error} body, matching the shape parseBody and the agent server already use.
  // These guards sit in front of /health, /tool and /sessions/* as well as /mcp, and only
  // /mcp speaks JSON-RPC — a JSON-RPC envelope would be noise everywhere else.
  //
  // Nothing is done to the request body: Node discards it once the response finishes, and
  // measurement shows that works cleanly even for multi-megabyte uploads on a reused
  // keep-alive socket. Closing or destroying the connection instead cuts the upload short
  // and the caller sees ECONNRESET rather than the status it needs to read.
  // The body echoes back the Host/Origin the caller sent, and a rebound top-level navigation
  // would render it in a browser tab — nosniff keeps that from ever being treated as HTML.
  logRejection(message);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify({ error: message }));
  return true;
}

/**
 * Gate every incoming request before it reaches any route.
 *
 * Pylon binds to 127.0.0.1, which keeps remote attackers out but not the browser running on
 * the same machine. Until this guard existed, any web page the user visited could POST a
 * tools/call to the hub and run shell commands — and read the output, because the servers
 * answered every origin with `Access-Control-Allow-Origin: *`.
 *
 * Required by MCP 2026-07-28: "Servers MUST validate the Origin header on all incoming
 * connections to prevent DNS rebinding attacks. If the Origin header is present and invalid,
 * servers MUST respond with HTTP 403 Forbidden."
 *
 * There is deliberately no allowlist. Pylon's clients are AI agents — CLI tools and editors,
 * not web pages — and none of them send an Origin. An escape hatch would have to serve real
 * CORS headers to be usable at all, and any origin it admitted could run terminal commands on
 * the machine. If a browser-based client ever genuinely needs in, that deserves its own design
 * rather than a setting that looks harmless.
 *
 * @returns true when the request was answered and the caller must stop.
 */
export function applyRequestGuards(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  // Host covers what Origin cannot see: a rebound name arrives as a same-origin request, and
  // same-origin GETs carry no Origin header at all. Absent Host is rejected rather than waved
  // through — HTTP/1.1 requires it, so a request without one is malformed regardless.
  const host = req.headers.host;
  const hostname = host?.replace(/:\d+$/, '').toLowerCase();
  if (hostname === undefined || !LOOPBACK_HOSTS.has(hostname)) {
    return rejectRequest(
      res,
      403,
      `Forbidden: unexpected Host ${host === undefined ? '(absent)' : `"${host}"`}. ` +
        'Pylon answers only on 127.0.0.1 and localhost.',
    );
  }

  // An Origin header means a browser made the request, which is never a Pylon client.
  // Note the converse does NOT hold: per the Fetch spec a browser omits Origin on GET and
  // HEAD in no-cors mode, so a page can still reach GET routes. That is what the Host check
  // above is for; do not add a GET route here assuming this check screens browsers out.
  const origin = req.headers.origin;
  if (origin !== undefined) {
    return rejectRequest(
      res,
      403,
      `Forbidden: requests from origin "${origin}" are not allowed. Pylon serves local AI ` +
        'agents, not browsers.',
    );
  }

  // No CORS headers are served anywhere, so a browser preflight cannot succeed by design.
  // RFC 9110 requires Allow on a 405, which also tells honest HTTP tooling what is accepted.
  if (req.method === 'OPTIONS') {
    return rejectRequest(res, 405, 'Method Not Allowed', { Allow: 'GET, POST' });
  }

  return false;
}

// ---------------------------------------------------------------------------
// Client helpers — used hub-to-satellite and for hub discovery.
// ---------------------------------------------------------------------------

/**
 * Track a server's connections so it can actually be stopped.
 *
 * `server.close()` stops accepting and then *waits for open connections to end* — and an SSE
 * stream never ends on its own, least of all one this code keeps alive with comment frames
 * every 15 seconds. Without this, stopping Pylon hangs until the client disconnects, the port
 * stays bound, and a restart races the old listener.
 */
export class ConnectionTracker {
  private sockets = new Set<net.Socket>();
  private streams = new Set<http.ServerResponse>();
  private outbound = new Set<http.ClientRequest>();

  /** Wire up a server so every accepted socket is tracked. */
  attach(server: http.Server): void {
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  /** Register a long-lived response so shutdown can end it deliberately. */
  addStream(res: http.ServerResponse): void {
    this.streams.add(res);
    res.on('close', () => this.streams.delete(res));
  }

  /**
   * Register an outbound request. The hub holding a connection open is what would keep a
   * satellite's own stop() from resolving, so both directions have to be released.
   */
  addOutbound(req: http.ClientRequest): void {
    this.outbound.add(req);
    const drop = (): void => { this.outbound.delete(req); };
    req.on('close', drop);
    req.on('error', drop);
  }

  /** Graceful first, then forceful. Returns once the server is really down. */
  async shutdown(server: http.Server, graceMs = 250, hardCapMs = 1000): Promise<void> {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));

    for (const res of this.streams) {
      try { res.end(); } catch { /* already gone */ }
    }
    this.streams.clear();
    for (const req of this.outbound) {
      try { req.destroy(); } catch { /* already gone */ }
    }
    this.outbound.clear();

    await new Promise((resolve) => setTimeout(resolve, graceMs));

    const withConnections = server as http.Server & { closeAllConnections?: () => void };
    if (typeof withConnections.closeAllConnections === 'function') {
      withConnections.closeAllConnections();
    } else {
      for (const socket of this.sockets) socket.destroy();
    }
    this.sockets.clear();

    // Resolve on the close callback or the hard cap, whichever comes first: a stop() that
    // never settles is worse than one that gives up, because the caller awaits it.
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, hardCapMs))]);
  }
}

/**
 * Parse an SSE byte stream into frames.
 *
 * Small enough to hand-roll, but four details are load-bearing:
 *  - `setEncoding('utf8')` must be on: otherwise `buf += chunk` decodes each Buffer on its own
 *    and splits a multi-byte character at the packet boundary. Terminal output is full of them.
 *  - The separator is tolerated as `\r\n\r\n` or `\n\n`.
 *  - Comment lines (`:`) are skipped — that is what a keep-alive looks like.
 *  - Multi-line `data:` fields are joined with `\n`, per the SSE spec.
 */
const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024;

export function createSseParser(onFrame: (payload: unknown) => void): (chunk: string) => void {
  let buf = '';
  return (chunk: string): void => {
    buf += chunk;
    // A peer that streams without ever sending a separator would otherwise grow this without
    // bound. Registration is unauthenticated, so that peer is not necessarily well-behaved.
    if (buf.length > MAX_SSE_FRAME_BYTES) {
      throw new Error(`SSE frame exceeded ${MAX_SSE_FRAME_BYTES} bytes without a separator`);
    }
    const separator = /\r?\n\r?\n/;
    let match: RegExpExecArray | null;
    while ((match = separator.exec(buf)) !== null) {
      const frame = buf.slice(0, match.index);
      buf = buf.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        onFrame(JSON.parse(data));
      } catch {
        // A frame we cannot parse is dropped rather than killing the stream.
      }
    }
  };
}

/**
 * POST and accept either answer: a buffered JSON body, or an SSE stream.
 *
 * This is how the hub forwards a tool call to a satellite that may or may not be running a
 * build new enough to stream. Each VS Code window is its own extension host, so after an
 * update only the reloaded window runs the new code — a new hub talking to an old satellite
 * is routine, not an edge case.
 */
export async function httpPostMaybeStream(
  url: string,
  body: object,
  onFrame: (payload: unknown) => void,
  timeoutMs?: number,
): Promise<{ streamed: boolean; body: string }> {
  return new Promise((resolve, rejectPromise) => {
    const payload = JSON.stringify(body);
    const urlObj = new URL(url);
    let cancel = (): void => {};
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: parseInt(urlObj.port, 10),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'text/event-stream, application/json',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const isStream = (res.headers['content-type'] ?? '').includes('text/event-stream');

        if (!isStream || status < 200 || status >= 300) {
          collect(res, url, (b) => { cancel(); resolve({ streamed: false, body: b }); },
            (err) => { cancel(); rejectPromise(err); });
          return;
        }

        res.setEncoding('utf8');
        const feed = createSseParser(onFrame);
        res.on('data', (chunk: string) => {
          try {
            feed(chunk);
          } catch (e) {
            // The parser refuses an oversized frame; drop the stream rather than let the
            // throw escape a 'data' listener and become an uncaught exception.
            req.destroy();
            cancel();
            rejectPromise(e instanceof Error ? e : new Error(String(e)));
          }
        });
        res.on('error', (err) => { cancel(); rejectPromise(err); });
        res.on('end', () => {
          cancel();
          // Nothing to hand back: the caller got the frames as they arrived, and decides on
          // the absence of a terminal frame whether the stream ended prematurely.
          resolve({ streamed: true, body: '' });
        });
      },
    );
    if (timeoutMs !== undefined) cancel = withDeadline(req, url, 'POST', timeoutMs);
    req.on('error', (err) => { cancel(); rejectPromise(err); });
    req.write(payload);
    req.end();
  });
}

/**
 * Open a long-lived SSE stream and feed its frames to a callback.
 *
 * Deliberately has no deadline: this connection is supposed to stay open for as long as the
 * peer lives. It ends when the peer closes it or the caller destroys the returned request,
 * and `onEnd` fires exactly once either way so a reconnect policy has a single trigger.
 */
export function httpGetStream(
  url: string,
  onFrame: (payload: unknown) => void,
  onEnd: (error?: Error) => void,
  onOpen?: () => void,
): http.ClientRequest {
  const feed = createSseParser(onFrame);
  let ended = false;
  const finish = (error?: Error): void => {
    if (ended) return;
    ended = true;
    onEnd(error);
  };

  const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      res.resume();
      finish(new Error(`HTTP ${status} from ${url}`));
      return;
    }
    onOpen?.();
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      try {
        feed(chunk);
      } catch (e) {
        // The parser refuses a frame that grows past its cap; drop the stream rather than
        // let it keep filling memory.
        req.destroy();
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
    res.on('error', (err) => finish(err));
    res.on('end', () => finish());
  });
  req.on('error', (err) => finish(err));
  return req;
}

/**
 * A non-2xx response. Carries the status so callers can act on it — a heartbeat answered 404
 * means "the hub has forgotten me", which is a different recovery than a refused connection.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`HTTP ${status} from ${url}${body ? `: ${body.slice(0, 500)}` : ''}`);
    this.name = 'HttpError';
  }
}

/**
 * Collect a response body, rejecting on a non-2xx status.
 *
 * `res.on('error')` matters as much as `req.on('error')`: without it a socket failure *after*
 * the headers arrived leaves the promise pending forever, and every caller of these helpers
 * awaits them on a path that has no other way out.
 */
function collect(
  res: http.IncomingMessage,
  url: string,
  resolve: (body: string) => void,
  reject: (err: Error) => void,
): void {
  res.setEncoding('utf8');
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('error', reject);
  res.on('end', () => {
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      reject(new HttpError(status, data, url));
      return;
    }
    resolve(data);
  });
}

/**
 * Bound the whole exchange, not just socket idleness.
 *
 * `req.setTimeout` fires only after N ms of *inactivity*, so a peer that trickles one byte
 * every so often keeps it from ever firing — measured: a 2000ms setTimeout let a 7-second
 * dribbling response through. A wall-clock timer is what actually bounds the call.
 */
function withDeadline(req: http.ClientRequest, url: string, method: string, timeoutMs: number): () => void {
  const timer = setTimeout(() => {
    req.destroy(new Error(`Timed out after ${timeoutMs}ms: ${method} ${url}`));
  }, timeoutMs);
  // Do not hold the extension host's event loop open for a request nobody is waiting on.
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * @param timeoutMs abort if the whole exchange takes longer. Discovery runs inside activate(),
 *        so a server that accepts the connection and then never answers must not be able to
 *        stall extension startup indefinitely.
 */
export function httpGet(url: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, rejectPromise) => {
    const req = http.get(url, (res) =>
      collect(res, url, (body) => { cancel(); resolve(body); }, (err) => { cancel(); rejectPromise(err); }),
    );
    const cancel = withDeadline(req, url, 'GET', timeoutMs);
    req.on('error', (err) => { cancel(); rejectPromise(err); });
  });
}

/**
 * @param timeoutMs abort if the whole exchange takes longer. Left unset by default because a
 *        forwarded tool call legitimately runs for minutes; callers that expect a fast reply
 *        (registration, heartbeat) pass their own.
 */
export function httpPost(url: string, body: object, timeoutMs?: number): Promise<string> {
  return new Promise((resolve, rejectPromise) => {
    const payload = JSON.stringify(body);
    const urlObj = new URL(url);
    let cancel = (): void => {};
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: parseInt(urlObj.port, 10),
        // search, not just pathname: this is the project's only POST helper, and dropping a
        // query string silently would send a subtly wrong request rather than failing.
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) =>
        collect(res, url, (b) => { cancel(); resolve(b); }, (err) => { cancel(); rejectPromise(err); }),
    );
    if (timeoutMs !== undefined) cancel = withDeadline(req, url, 'POST', timeoutMs);
    req.on('error', (err) => { cancel(); rejectPromise(err); });
    req.write(payload);
    req.end();
  });
}
