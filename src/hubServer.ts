import * as http from 'http';
import * as vscode from 'vscode';
import { AgentServer, ToolResult } from './agentServer';
import {
  applyRequestGuards,
  ConnectionTracker,
  exponentialBackoffMs,
  guardedSseWrite,
  httpGetStream,
  httpPost,
  httpPostMaybeStream,
  normalizeAgentUrl,
  oneLine,
  rejectRequest,
  sanitizeLabel,
  sseWrite,
  startKeepAlive,
  SSE_HEADERS,
} from './http';
import { HUB_TOOLS, SESSION_ID_NOTE } from './toolDefinitions';
import { EventBus, type PylonEventKind } from './events';
import {
  detectRegime,
  discoverResult,
  initializeResult,
  isNotification,
  shapeResult,
  resourceUriForEvent,
  validateModernHeaders,
  META_SUBSCRIPTION_ID,
  RESOURCE_TEMPLATES,
  SESSIONS_RESOURCE,
  SUBSCRIPTION_TYPES,
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  ERR_TOOL_DISABLED,
  type MCPRequest,
  type MCPResponse,
  type Regime,
} from './protocol';

/** Kept in sync with package.json by the release step. */
const SERVER_IDENTITY = { name: 'pylon', version: '0.6.0' } as const;

/** A `pylon://` URI failed to parse (e.g. a lone `%` in a malformed percent-escape) — this is
 * a client-input problem, distinct from every other failure readResource can throw. */
class InvalidResourceUriError extends Error {}

interface SessionEntry {
  agentUrl: string;
  lastSeen: number;
  /** Open reverse-channel request, when one is established. */
  stream?: http.ClientRequest;
  /** Earliest time to try opening a stream again, for backoff after a failure. */
  nextAttemptAt?: number;
  /** Consecutive failed attempts, driving that backoff. */
  attempts?: number;
  /** Last `seq` seen on this session's event stream, so a reconnect can reveal a gap. */
  lastSeq?: number;
}

const STALE_MS = 15000;

export class HubServer {
  private server: http.Server | null = null;
  private ownAgent: AgentServer;
  private ownSessionId: string;
  private sessions = new Map<string, SessionEntry>();
  private connections = new ConnectionTracker();
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Fan-out to MCP clients that opened subscriptions/listen. */
  readonly events = new EventBus();
  private subscriptionSeq = 0;
  private stopping = false;
  /** Released on stop(): a discarded HubServer would otherwise be retained by this listener. */
  private unsubscribeOwnEvents: (() => void) | null = null;
  readonly port: number;

  constructor(ownAgent: AgentServer, ownSessionId: string, port = 27681) {
    this.ownAgent = ownAgent;
    // The hub's own window has no reverse channel to open — it is this process. Without this
    // bridge a single-window setup, which is the common one, would see no notifications at all.
    this.unsubscribeOwnEvents = ownAgent.events.subscribe((event) => {
      this.events.emit(event.kind, { ...event.data, session: this.ownSessionId });
    });
    // Sanitized rather than validated: the id comes from the workspace folder name, and a
    // folder may legally contain a quote or newline. Refusing it the way registerSession
    // refuses a satellite would leave the hub unable to register itself, so the one entry
    // that must always exist is cleaned instead — it still has to be a single safe field in
    // the line-oriented terminal_list_sessions output.
    this.ownSessionId = sanitizeLabel(ownSessionId);
    this.port = port;
    this.sessions.set(this.ownSessionId, {
      agentUrl: `http://127.0.0.1:${ownAgent.port}`,
      lastSeen: Date.now(),
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(this.createHandler());
      this.connections.attach(server);
      server.on('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        // Armed only once the port is actually ours. Arming before listen() leaked an
        // interval on every lost startup race — and callers discard a failed HubServer
        // without calling stop(), so nothing would ever have cleared it.
        this.sweepTimer = setInterval(() => this.reconcile(), 5000);
        this.sweepTimer.unref?.();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribeOwnEvents?.();
    this.unsubscribeOwnEvents = null;
    this.events.dispose();
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    const server = this.server;
    if (!server) return;
    this.server = null;   // set before awaiting: isRunning must not claim a server that is going away
    await this.connections.shutdown(server);
  }

  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** The id this hub actually registered its own window under, after sanitizing. */
  get sessionId(): string {
    return this.ownSessionId;
  }

  /**
   * @returns the id actually registered, or a reason string when the registration was refused.
   */
  registerSession(sessionId: unknown, agentUrl: unknown): { sessionId: string } | string {
    // Every tool call routed to this session is POSTed to agentUrl, so an off-machine value
    // would stream command text and terminal output straight off the box.
    const normalized = normalizeAgentUrl(agentUrl);
    if (normalized === null) {
      return `agentUrl ${JSON.stringify(agentUrl)} must be http://127.0.0.1:<port>`;
    }
    // A non-string id would land in the Map as-is and inflate sessions.size, which flips the
    // "multiple sessions active" fail-safe in routeToolCall and breaks every session_id-less
    // call a single-window user makes. The charset check keeps the id out of the line-oriented
    // terminal_list_sessions output as anything but one field: a newline in here would forge an
    // extra `[hub] session="…" agent=…` row in what the agent reads and routes on.
    // Control characters and quotes are excluded rather than allow-listing a charset: folder
    // names legitimately contain umlauts, CJK and spaces, and \w would reject "München".
    // Deliberately the same charset as sanitizeLabel's (`/` is allowed): resourceUriForEvent
    // percent-encodes the session id before embedding it in a pylon:// URI either way, so
    // excluding `/` here bought no extra safety, only an inconsistency between the two checks.
    if (typeof sessionId !== 'string' || !/^[^\x00-\x1f"]{1,200}$/.test(sessionId)) {
      return `sessionId ${JSON.stringify(sessionId)} must be 1-200 characters without control characters or quotes`;
    }
    // Last writer wins, deliberately. An earlier version refused to repoint a session whose
    // entry was still fresh, meaning to slow down a local process hijacking another window's
    // traffic — but it also refused the legitimate cases: a window reloading onto a different
    // agent port within 15s, and two workspace folders that share a name (sessionId is just
    // `workspaceFolders[0].name`). Those windows then stayed invisible to every agent with no
    // way to recover. Registration is unauthenticated either way, so the guard bought ~15
    // seconds against an attacker and cost real users a broken window; see the README security
    // note, and the token-auth item in the plan for the actual fix.
    // Two windows can legitimately derive the same id — sessionId is just the workspace
    // folder name, and two folders may share one (or both windows may have none, giving
    // 'default'). Refusing the second one left it invisible to every agent with no way back,
    // and letting it overwrite the hub's own row was worse: that row never expires and
    // routeToolCall short-circuits on it, so the satellite became unreachable *and*
    // mislabelled. So disambiguate instead, and tell the caller which id it actually got.
    // Prune first: a dead window's row would otherwise push a restarting window onto a #N
    // suffix and leave two rows for one window until the staleness sweep catches up.
    this.pruneStaleSessions();
    let effective = sessionId;
    const taken = (id: string): boolean => {
      const existing = this.sessions.get(id);
      return existing !== undefined && existing.agentUrl !== normalized;
    };
    for (let n = 2; taken(effective); n++) effective = `${sessionId}#${n}`;

    // Destroy any reverse channel the entry being replaced was holding — otherwise a window
    // that re-registers on a new agent port orphans the old outbound connection with nothing
    // left to track it, exactly the leak the staleness sweep and /sessions/unregister avoid.
    this.sessions.get(effective)?.stream?.destroy();
    this.sessions.set(effective, { agentUrl: normalized, lastSeen: Date.now() });
    return { sessionId: effective };
  }

  heartbeat(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.lastSeen = Date.now();
    this.pruneStaleSessions();
    return true;
  }

  listSessions(): Array<{ sessionId: string; agentUrl: string; isHub: boolean }> {
    this.pruneStaleSessions();
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      sessionId: id,
      agentUrl: s.agentUrl,
      isHub: id === this.ownSessionId,
    }));
  }

  /**
   * One idempotent tick that owns staleness *and* the reverse channel.
   *
   * Folding "open on registration", "reopen after a satellite died" and "reopen after this
   * window was promoted" into a single reconciliation is what makes promotion need no special
   * case: a promoted hub starts with only itself registered, satellites re-register within a
   * heartbeat, and the next tick opens the streams.
   */
  private reconcile(): void {
    // A listen stream closing during shutdown would otherwise re-open satellite connections
    // that the tracker has already released, leaving them with nothing to destroy them.
    if (this.stopping) return;
    this.pruneStaleSessions();
    const wanted = this.events.subscriberCount > 0;
    const now = Date.now();

    for (const [sessionId, session] of this.sessions) {
      if (sessionId === this.ownSessionId) continue;   // own events come from the local bus

      if (!wanted) {
        // Nobody is listening — do not hold connections open for events nobody reads.
        session.stream?.destroy();
        session.stream = undefined;
        continue;
      }
      if (session.stream !== undefined) continue;
      if (session.nextAttemptAt !== undefined && now < session.nextAttemptAt) continue;

      this.openEventStream(sessionId, session);
    }
  }

  private openEventStream(sessionId: string, session: SessionEntry): void {
    const url = `${session.agentUrl}/events`;
    const request = httpGetStream(
      url,
      (payload) => {
        const frame = payload as { t?: string; kind?: string; seq?: number; data?: Record<string, unknown> };
        if (frame.t !== 'event' || typeof frame.kind !== 'string') return;
        // The satellite's seq is per-emitter and monotonic (see events.ts); a jump means this
        // stream's reconnect (backoff, or the tick simply losing a race) missed some events in
        // between. Nothing here can recover them — the resource model is "re-read on any event
        // in that family", not a diff — so this only surfaces the loss for diagnosis.
        const entry = this.sessions.get(sessionId);
        if (entry !== undefined && typeof frame.seq === 'number') {
          if (entry.lastSeq !== undefined && frame.seq > entry.lastSeq + 1) {
            console.warn(
              `[pylon] event stream for session "${sessionId}" skipped ${frame.seq - entry.lastSeq - 1} ` +
              `event(s) (seq ${entry.lastSeq} -> ${frame.seq})`
            );
          }
          entry.lastSeq = frame.seq;
        }
        this.events.emit(frame.kind as PylonEventKind, { ...frame.data, session: sessionId });
      },
      () => {
        // Closed or failed: back off and let a later tick retry. Capped so a window that is
        // simply gone does not get hammered, and reset once a stream is established.
        const entry = this.sessions.get(sessionId);
        if (entry === undefined || entry.stream !== request) return;
        entry.stream = undefined;
        entry.attempts = (entry.attempts ?? 0) + 1;
        entry.nextAttemptAt = Date.now() + exponentialBackoffMs(entry.attempts, 1000, 30_000);
      },
      () => {
        const entry = this.sessions.get(sessionId);
        // Same identity guard as the failure callback: a stream superseded by a newer one
        // (a fast re-register while the old outbound request was still connecting) must not
        // reset the backoff the *new* stream is tracking.
        if (entry === undefined || entry.stream !== request) return;
        entry.attempts = 0;
        entry.nextAttemptAt = undefined;
      },
    );
    session.stream = request;
    this.connections.addOutbound(request);
  }

  private pruneStaleSessions(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (id !== this.ownSessionId && now - s.lastSeen > STALE_MS) {
        s.stream?.destroy();
        this.sessions.delete(id);
      }
    }
  }

  private createHandler() {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      // No CORS headers are served: Pylon has no legitimate browser client, and a
      // permissive Access-Control-Allow-Origin was what made this endpoint reachable
      // from any web page the user happened to visit.
      // Swallow client-disconnect errors on every route, not just the streaming one. A write
      // to a destroyed response emits 'error', and an unhandled 'error' on a ServerResponse
      // takes down the extension host — reachable on any handler that answers after a wait.
      res.on('error', () => {});

      if (applyRequestGuards(req, res)) return;

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', role: 'hub', sessionId: this.ownSessionId }));
        return;
      }

      if (req.method === 'POST' && req.url === '/sessions/register') {
        this.parseBody(req, res, (body) => {
          const { sessionId, agentUrl } = body as { sessionId: string; agentUrl: string };
          const outcome = this.registerSession(sessionId, agentUrl);
          if (typeof outcome === 'string') {
            rejectRequest(res, 400, `Registration refused: ${outcome}.`);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // The effective id may differ from the requested one; the satellite must adopt it
          // or its heartbeats would address a session the hub does not have.
          res.end(JSON.stringify({ ok: true, sessionId: outcome.sessionId }));
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/sessions/unregister') {
        this.parseBody(req, res, (body) => {
          const { sessionId } = body as { sessionId?: unknown };
          // A clean goodbye, so a closing window is not indistinguishable from a crash for the
          // 15 seconds it takes the staleness sweep to notice.
          let removed = false;
          if (typeof sessionId === 'string' && sessionId !== this.ownSessionId) {
            // Destroy the reverse channel before dropping the row, exactly as the staleness
            // sweep does — otherwise the outbound request is orphaned with no bookkeeping.
            this.sessions.get(sessionId)?.stream?.destroy();
            removed = this.sessions.delete(sessionId);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: removed === true }));
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/sessions/heartbeat') {
        this.parseBody(req, res, (body) => {
          const { sessionId } = body as { sessionId: string };
          const ok = this.heartbeat(sessionId);
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        });
        return;
      }

      // The modern revision removed the GET stream endpoint; a server that only speaks
      // Streamable HTTP answers GET/DELETE here with 405 rather than a bare 404, so a client
      // can tell "wrong method" from "no such endpoint".
      if ((req.method === 'GET' || req.method === 'DELETE') && req.url === '/mcp') {
        rejectRequest(res, 405, 'Method Not Allowed: the MCP endpoint accepts POST', { Allow: 'POST' });
        return;
      }

      if (req.method === 'POST' && req.url === '/mcp') {
        this.parseBody(req, res, async (body) => {
          const request = body as MCPRequest;
          const regime = detectRegime(request, req.headers);

          if (regime === 'modern') {
            const problem = validateModernHeaders(request, req.headers);
            if (problem !== null) {
              res.writeHead(problem.httpStatus, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: request.id ?? null,
                error: { code: problem.code, message: problem.message, ...(problem.data ? { data: problem.data } : {}) },
              }));
              return;
            }
          }

          // A notification carries no id and must not be answered with a response object.
          // The transport says so plainly: accept it with 202 and an empty body.
          if (isNotification(request)) {
            res.writeHead(202);
            res.end();
            return;
          }

          // subscriptions/listen answers with a stream of its own that stays open. It carries
          // ONLY the change notifications the client opted into — the spec is explicit that
          // request-scoped notifications like progress travel on their own request's stream,
          // never on this one.
          if (request.method === 'subscriptions/listen') {
            this.handleListen(request, res, regime);
            return;
          }

          const progressToken =
            request.method === 'tools/call'
              ? (request.params as { _meta?: { progressToken?: string | number } } | undefined)?._meta?.progressToken
              : undefined;

          if (progressToken !== undefined && progressToken !== null) {
            // MCP streamable-HTTP transport: stream responses are Server-Sent Events.
            res.writeHead(200, { ...SSE_HEADERS });
            // Commit the headers now, so the client sees the stream open immediately instead
            // of when the first frame happens to arrive.
            res.flushHeaders();
            this.connections.addStream(res);
            const stopKeepAlive = startKeepAlive(res);

            // Closing the stream is the cancellation signal in this revision of the spec, and
            // there is no other one: "Closing the SSE response stream MUST be treated by the
            // server as cancellation of that request." Stop writing the moment it happens.
            //
            // This must watch the RESPONSE, not the request: since Node 16 IncomingMessage
            // emits 'close' when the request finishes being read, which has already happened
            // by the time this handler runs — watching `req` would mark every single stream
            // aborted a tick later and silently swallow its result.
            let aborted = false;
            res.on('close', () => { aborted = true; });

            let progressBytes = 0;
            // Drop progress rather than buffer it. These frames are advisory: the tool's
            // final result carries the complete output regardless of what was streamed, so
            // a slow reader costs the client some mid-flight detail, never correctness —
            // whereas queueing every chunk of a verbose build is an OOM waiting to happen.
            const write = guardedSseWrite(res);
            const onProgress = (chunk: string) => {
              // Counted even when the frame is dropped: `progress` is meant to track the
              // tool's output, so skipping the increment would under-report by however much
              // was produced while a slow reader was catching up. Byte length, not string
              // length: a multi-byte character must count as what it costs on the wire.
              progressBytes += Buffer.byteLength(chunk, 'utf8');
              if (aborted) return;
              write({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken, progress: progressBytes, message: chunk },
              });
            };

            try {
              const response = await this.handleMCPRequest(request, regime, onProgress);
              if (!aborted) {
                sseWrite(res, response);
                res.end();
              }
            } finally {
              stopKeepAlive();
            }
          } else {
            const response = await this.handleMCPRequest(request, regime);
            // An unknown method is a 404 in the modern revision — the JSON-RPC body is what
            // distinguishes it from a 404 served by something that is not an MCP endpoint.
            const status =
              regime === 'modern' && response.error?.code === ERR_METHOD_NOT_FOUND ? 404 : 200;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    };
  }

  private parseBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (body: unknown) => void | Promise<void>
  ): void {
    // A StringDecoder, not `Buffer += `: without it each chunk is decoded on its own, so a
    // multi-byte character split across a socket read becomes two replacement characters —
    // and JSON.parse still succeeds, so the corruption is silent. Reachable on any body over
    // ~64 KB containing an umlaut, CJK or emoji.
    // The response side got this guard; the request side needs it just as much — a reset
    // mid-upload emits 'error' here, and an unhandled one takes down the extension host.
    req.on('error', () => {});
    req.setEncoding('utf8');
    let body = '';
    let bodySize = 0;
    const MAX_BODY = 1024 * 1024; // 1 MB
    req.on('data', (chunk: string) => {
      // Byte length, not string length: setEncoding above hands us strings, and a cap counted
      // in UTF-16 code units would let a CJK body through at ~3x the documented 1 MB.
      bodySize += Buffer.byteLength(chunk, 'utf8');
      if (bodySize <= MAX_BODY) { body += chunk; }
    });
    req.on('end', async () => {
      if (bodySize > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
      try {
        await handler(JSON.parse(body));
      } catch (e) {
        // The streaming branch commits headers before it awaits, so a throw after that point
        // must not try to answer again — writeHead on an already-headed response raises
        // ERR_HTTP_HEADERS_SENT inside this async listener, i.e. an uncaught exception in the
        // extension host instead of the intended 400.
        if (res.headersSent) {
          console.warn(`[pylon] request failed after headers were sent: ${String(e)}`);
          res.end();
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  }

  /** Serve a subscriptions/listen stream until the client goes away. */
  private handleListen(request: MCPRequest, res: http.ServerResponse, regime: Regime): void {
    const params = (request.params ?? {}) as { types?: unknown; uris?: unknown };
    // Omitting `types` is a plausible "give me everything" client shape, not a request for
    // nothing — defaulting the filter away entirely would otherwise leave the stream
    // registered but silently deliver zero notifications forever.
    const requested = Array.isArray(params.types) ? params.types.map(String) : [...SUBSCRIPTION_TYPES];
    const types = new Set(SUBSCRIPTION_TYPES.filter((t) => requested.includes(t)));
    const uris = new Set(Array.isArray(params.uris) ? params.uris.map(String) : []);
    const subscriptionId = `sub-${++this.subscriptionSeq}`;

    res.writeHead(200, { ...SSE_HEADERS });
    res.flushHeaders();
    this.connections.addStream(res);
    const stopKeepAlive = startKeepAlive(res);

    // Acknowledge first, so the client knows which id its notifications will carry.
    // The id belongs inside result._meta: a JSON-RPC response carries only jsonrpc/id/
    // result, and a client holding two listen streams needs it to tell their notifications
    // apart. Computed as a local so the subscription id merges into shapeResult's own
    // _meta instead of overwriting it (a literal `_meta:` key here would be a later key in
    // the same object literal and clobber shapeResult's serverInfo entry).
    const shaped = shapeResult({ subscribed: [...types], uris: [...uris] }, regime, SERVER_IDENTITY);
    sseWrite(res, {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        ...shaped,
        _meta: { ...(shaped._meta as Record<string, unknown> | undefined), [META_SUBSCRIPTION_ID]: subscriptionId },
      },
    });

    // Same drop-don't-buffer rule as the other stream writer in this file.
    const write = guardedSseWrite(res);
    const unsubscribe = this.events.subscribe((event) => {
      const session = typeof event.data.session === 'string' ? event.data.session : this.ownSessionId;
      const uri = resourceUriForEvent(event.kind, session, event.data);
      if (uri === null) return;
      // Either the client asked for this exact resource, or it asked for the blanket
      // resource-subscription type.
      if (!types.has('resourceSubscriptions') && !uris.has(uri)) return;
      write({
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri, _meta: { [META_SUBSCRIPTION_ID]: subscriptionId } },
      });
    });
    // Without this, the very first subscriber would get no satellite events until the next
    // periodic reconcile tick fires (up to 5s later), even though the subscription itself is
    // registered instantly above.
    this.reconcile();

    res.on('close', () => {
      unsubscribe();
      stopKeepAlive();
      // Last listener out closes the reverse channels: the next reconcile tick sees no
      // subscribers and tears the satellite streams down.
      this.reconcile();
    });
  }

  /**
   * Resolve a pylon:// URI by routing to the tool that already produces that view.
   *
   * Resources are a read-only projection of what the tools return, so there is no second
   * implementation to keep in step.
   */
  private async readResource(uri: string): Promise<string | null> {
    // Resources are a read-only view of the tools, so they must honour the same access
    // control — otherwise disabling a tool in the picker hides it from tools/list while the
    // identical output stays readable one URI away.
    const disabled = this.disabledTools();
    const guard = (tool: string): void => {
      if (disabled.has(tool)) throw new Error(`Tool "${tool}" is disabled in Pylon settings.`);
    };
    const match = /^pylon:\/\/([^/]+)\/(.+)$/.exec(uri);
    if (match === null && uri !== SESSIONS_RESOURCE.uri) return null;
    // Percent-decoded: a terminal named "Git Bash" or a disambiguated session id like "api#2"
    // only round-trips through a URI in encoded form. Decoding outside the try below (and in
    // its own try/catch) so a malformed escape is reported as the client-input error it is,
    // not folded into the generic ERR_INTERNAL the outer catch would otherwise produce.
    let session = '';
    let rest = '';
    try {
      session = match === null ? '' : decodeURIComponent(match[1]);
      rest = match === null ? '' : decodeURIComponent(match[2]);
    } catch {
      throw new InvalidResourceUriError(`Malformed resource URI: ${uri}`);
    }

    // Deliberately uncaught: a tool-disabled guard or a routeToolCall failure (session not
    // found, satellite unreachable, ...) must surface as a real JSON-RPC error, not as
    // stringified "Unavailable: ..." success content a client can't distinguish from a
    // resource that legitimately contains that text. It propagates to handleMCPRequest's
    // outer try/catch, which turns it into ERR_INTERNAL.
    if (uri === SESSIONS_RESOURCE.uri) {
      guard('terminal_list_sessions');
      return (await this.routeToolCall('terminal_list_sessions', {})).content[0]?.text ?? '';
    }
    if (rest === 'diagnostics') {
      guard('get_diagnostics');
      return (await this.routeToolCall('get_diagnostics', { session_id: session })).content[0]?.text ?? '';
    }
    if (rest === 'debug/state') {
      guard('debug_state');
      return (await this.routeToolCall('debug_state', { session_id: session })).content[0]?.text ?? '';
    }
    const terminal = /^terminal\/(.+)\/buffer$/.exec(rest);
    if (terminal !== null) {
      guard('terminal_read_output');
      return (await this.routeToolCall('terminal_read_output', {
        session_id: session,
        terminal_name: terminal[1],
      })).content[0]?.text ?? '';
    }
    return null;
  }

  private disabledTools(): Set<string> {
    return new Set(vscode.workspace.getConfiguration('pylon').get<string[]>('disabledTools', []));
  }

  private async handleMCPRequest(
    req: MCPRequest,
    regime: Regime,
    onProgress?: (chunk: string) => void,
  ): Promise<MCPResponse> {
    const base = { jsonrpc: '2.0' as const, id: req.id ?? null };
    const identity = SERVER_IDENTITY;
    const shape = (result: object, cache?: { ttlMs: number; cacheScope: 'public' | 'private' }) =>
      ({ ...base, result: shapeResult(result as Record<string, unknown>, regime, identity, cache) });

    try {
      switch (req.method) {
        // Modern: servers MUST implement this. It is how a client learns the supported
        // versions, capabilities and identity without probing each list endpoint.
        case 'server/discover':
          return { ...base, result: discoverResult(identity, SESSION_ID_NOTE) };

        // Legacy: the pre-2026 handshake.
        case 'initialize':
          return {
            ...base,
            result: initializeResult((req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion, identity),
          };

        case 'resources/list':
          return shape(
            { resources: [SESSIONS_RESOURCE] },
            { ttlMs: 30_000, cacheScope: 'private' },
          );

        case 'resources/templates/list':
          return shape(
            { resourceTemplates: RESOURCE_TEMPLATES },
            { ttlMs: 3_600_000, cacheScope: 'public' },
          );

        case 'resources/read': {
          const uri = String((req.params as { uri?: unknown } | undefined)?.uri ?? '');
          let contents: string | null;
          try {
            contents = await this.readResource(uri);
          } catch (e) {
            if (e instanceof InvalidResourceUriError) {
              return { ...base, error: { code: ERR_INVALID_PARAMS, message: e.message } };
            }
            throw e;
          }
          if (contents === null) {
            // -32602, not -32002: the spec realigned this with JSON-RPC's own invalid-params.
            return { ...base, error: { code: ERR_INVALID_PARAMS, message: `Resource not found: ${uri}` } };
          }
          return shape(
            { contents: [{ uri, mimeType: 'text/plain', text: contents }] },
            { ttlMs: 2_000, cacheScope: 'private' },
          );
        }

        case 'tools/list': {
          const disabled = this.disabledTools();
          const tools = disabled.size > 0 ? HUB_TOOLS.filter((t) => !disabled.has(t.name)) : HUB_TOOLS;
          // ttlMs/cacheScope let a client cache the list instead of re-fetching it; the list
          // only changes when pylon.disabledTools does.
          return shape({ tools }, { ttlMs: 60_000, cacheScope: 'private' });
        }

        case 'tools/call': {
          const params = req.params as { name: string; arguments: Record<string, unknown> };
          if (this.disabledTools().has(params.name)) {
            return {
              ...base,
              // Deliberately not ERR_METHOD_NOT_FOUND: that maps to HTTP 404 in the modern
              // regime, which a client reads as "this session is gone" and responds to by
              // tearing down and re-handshaking — instead of showing the user why.
              error: {
                code: ERR_TOOL_DISABLED,
                message: `Tool "${params.name}" is disabled. Enable it in Pylon settings.`,
              },
            };
          }
          const result = await this.routeToolCall(params.name, params.arguments ?? {}, onProgress);
          return shape(result);
        }

        // Reached only when a client stamps an id on it; without an id the transport already
        // answered 202. Returning an empty result keeps such a handshake moving instead of
        // failing it with a method-not-found that the modern regime turns into a 404.
        case 'notifications/initialized':
          return shape({});

        default:
          return {
            ...base,
            error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${req.method}` },
          };
      }
    } catch (e) {
      return { ...base, error: { code: ERR_INTERNAL, message: String(e) } };
    }
  }

  private async routeToolCall(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (chunk: string) => void,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const text = (s: string) => ({ content: [{ type: 'text', text: s }] });

    if (name === 'terminal_list_sessions') {
      const sessions = this.listSessions();
      if (sessions.length === 0) return text('No sessions registered.');
      const lines = sessions.map(
        (s) => `${s.isHub ? '[hub]' : '[satellite]'} session="${s.sessionId}" agent=${s.agentUrl}`
      );
      return text(lines.join('\n'));
    }

    const sessionId = args.session_id as string | undefined;

    // Fail-safe: reject calls without session_id when multiple sessions are active
    // (except terminal_list which aggregates across all sessions)
    // Prune first: without it a closed window's stale entry keeps sessions.size at 2 and
    // every session_id-less call fails, naming a window that no longer exists.
    this.pruneStaleSessions();
    if (!sessionId && name !== 'terminal_list' && this.sessions.size > 1) {
      const available = [...this.sessions.keys()].map((s) => `"${s}"`).join(', ');
      throw new Error(
        `Multiple sessions active — session_id is required. ` +
        `Available sessions: ${available}. ` +
        `Use terminal_list_sessions to discover sessions, then pass session_id with every tool call.`
      );
    }

    // Aggregate terminal_list across all sessions when no session_id given
    if (name === 'terminal_list' && !sessionId) {
      // Already pruned above, unconditionally, with nothing async in between to go stale.
      const parts: string[] = [];
      // Fan out in parallel with a short deadline: this is a listing, and one wedged window
      // must not stall it. Sequentially at the forwarding ceiling, a single unresponsive
      // satellite held the whole call for seven minutes.
      const entries = [...this.sessions.entries()];
      const results = await Promise.all(entries.map(async ([sid, session]) => {
        try {
          const result =
            sid === this.ownSessionId
              ? await this.ownAgent.callTool('terminal_list', args)
              : await forwardToAgent(session.agentUrl, 'terminal_list', args, undefined, LIST_TIMEOUT_MS);
          // An empty reply contributes nothing rather than a bare `[sid] ` row, which an
          // agent would read as a terminal with no name.
          const body = result.content[0]?.text ?? '';
          return body ? body.split('\n').map((l) => `[${sid}] ${l}`) : [];
        } catch (e) {
          // Report what actually went wrong. This used to say "(unreachable)" for every
          // failure, which was a lie whenever the window was reachable and the tool simply
          // returned an error — the most common case in normal use.
          //
          // Collapsed to a single line: the message can carry a chunk of the agent's response
          // body, and a newline in it would forge extra rows in this line-oriented output —
          // the same forgery the sessionId charset check exists to prevent.
          return [`[${sid}] (failed: ${oneLine(e instanceof Error ? e.message : String(e))})`];
        }
      }));
      for (const lines of results) parts.push(...lines);
      return text(parts.join('\n') || 'No terminals open across any session.');
    }

    // Route to satellite if session_id targets one
    if (sessionId && sessionId !== this.ownSessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(
          `Session "${sessionId}" not found. Use terminal_list_sessions to see available sessions.`
        );
      }
      // Progress streams from satellite windows too: the forwarded call asks for SSE when
      // there is a sink for it, and falls back to a buffered answer against an older Pylon.
      return await forwardToAgent(session.agentUrl, name, args, onProgress);
    }

    // Handle locally (hub's own window). Bounded the same way the satellite branch above is
    // bounded (FORWARD_TIMEOUT_MS) — a hung debugger/IDE call routed to the hub's own window
    // used to be able to hang indefinitely while the identical call to a satellite was capped.
    // terminal_run/terminal_wait are exempt: their own timeout_ms argument is the caller's
    // explicit contract and may legitimately run longer than FORWARD_TIMEOUT_MS.
    if (UNBOUNDED_OWN_WINDOW_TOOLS.has(name)) {
      return await this.ownAgent.callTool(name, args, onProgress);
    }
    return await withTimeout(
      this.ownAgent.callTool(name, args, onProgress),
      FORWARD_TIMEOUT_MS,
      `Tool "${name}" in the hub's own window did not respond within ${FORWARD_TIMEOUT_MS}ms`,
    );
  }
}

/** Hard ceiling on a forwarded call, above the 300s a terminal_run may legitimately take. */
const FORWARD_TIMEOUT_MS = 420_000;

/** A listing must not inherit the ceiling sized for a long-running command. */
const LIST_TIMEOUT_MS = 4_000;

/** Tools whose caller-supplied `timeout_ms` argument is an explicit contract that may
 * legitimately exceed FORWARD_TIMEOUT_MS — exempt from routeToolCall's own-window ceiling. */
const UNBOUNDED_OWN_WINDOW_TOOLS = new Set(['terminal_run', 'terminal_wait']);

/** Rejects with `message` if `promise` has not settled within `timeoutMs`. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function forwardToAgent(
  agentUrl: string,
  tool: string,
  params: Record<string, unknown>,
  onProgress?: (chunk: string) => void,
  timeoutMs: number = FORWARD_TIMEOUT_MS,
): Promise<ToolResult> {
  // Without a progress sink there is nothing to stream to, so ask for the cheaper buffered
  // answer — which also keeps the terminal_list aggregation on exactly the bytes it had.
  if (!onProgress) {
    const raw = await httpPost(`${agentUrl}/tool`, { tool, params }, timeoutMs);
    return parseToolResult(raw, agentUrl);
  }

  let terminal: { t: string; result?: unknown; error?: { message: string } } | null = null;
  const outcome = await httpPostMaybeStream(
    `${agentUrl}/tool`,
    { tool, params },
    (payload) => {
      const frame = payload as { t?: string; chunk?: string; result?: unknown; error?: { message: string } };
      if (frame.t === 'progress' && typeof frame.chunk === 'string') {
        onProgress(frame.chunk);
        return;
      }
      if (frame.t === 'result' || frame.t === 'error') {
        terminal = frame as { t: string; result?: unknown; error?: { message: string } };
      }
    },
    timeoutMs,
  );

  // An older satellite ignores the Accept header and answers buffered JSON.
  if (!outcome.streamed) return parseToolResult(outcome.body, agentUrl);

  const done = terminal as { t: string; result?: unknown; error?: { message: string } } | null;
  if (done === null) {
    throw new Error(`Agent at ${agentUrl} closed the stream before delivering a result`);
  }
  if (done.t === 'error') {
    throw new Error(done.error?.message ?? `Agent at ${agentUrl} reported an unspecified error`);
  }
  return validateToolResult(done.result, agentUrl, JSON.stringify(done.result));
}

function parseToolResult(raw: string, agentUrl: string): ToolResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Agent at ${agentUrl} returned a non-JSON response: ${oneLine(raw, 200)}`);
  }
  return validateToolResult(parsed, agentUrl, raw);
}

function validateToolResult(parsed: unknown, agentUrl: string, raw: string): ToolResult {
  // Validate rather than cast. An agent that answers with anything but a ToolResult — an error
  // envelope, a 404 body, a future shape — would otherwise be handed to the MCP client as a
  // result with no `content`, and every reader of result.content[0] throws on it downstream.
  const result = parsed as ToolResult;
  if (!result || !Array.isArray(result.content)) {
    throw new Error(`Agent at ${agentUrl} returned a malformed tool result: ${oneLine(raw, 200)}`);
  }
  return result;
}
