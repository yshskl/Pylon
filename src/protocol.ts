import * as http from 'http';

/**
 * MCP protocol handling, kept free of VS Code imports so it is about the wire format and
 * nothing else.
 *
 * Pylon speaks two eras at once. Revision 2026-07-28 removed the `initialize` handshake and
 * made every request carry its own version in `_meta`; everything before it negotiates once
 * and keeps that version for the session. The spec sanctions serving both — it calls this a
 * "dual-era server" — and Pylon can do it cheaply because it never held session state to
 * begin with: `initialize` always returned a constant.
 */

/** Revisions Pylon answers under the pre-2026 handshake. */
export const LEGACY_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'] as const;

/** The stateless revision. */
export const MODERN_VERSION = '2026-07-28';

export const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS] as const;

/** `_meta` keys the modern revision defines. */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** Error codes from the range the MCP spec reserves for itself (-32020 to -32099). */
export const ERR_HEADER_MISMATCH = -32020;
export const ERR_UNSUPPORTED_VERSION = -32022;
/** Server-defined error range (-32000 to -32099, outside the spec's own reservations above). */
export const ERR_TOOL_DISABLED = -32001;
/** JSON-RPC's own codes. */
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;

/** Decode the `=?base64?…?=` sentinel the spec defines for header values that are not plain ASCII. */
function decodeHeaderValue(raw: string): string {
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(raw);
  return match ? Buffer.from(match[1], 'base64').toString('utf8') : raw;
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined ? undefined : decodeHeaderValue(value);
}

export type Regime = 'legacy' | 'modern';

export interface MCPRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** An error that carries the HTTP status the transport must answer with. */
export interface ProtocolError {
  httpStatus: number;
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Which era this request belongs to.
 *
 * The discriminator is a header, evaluated per request, with no state anywhere: a request that
 * announces `MCP-Protocol-Version` is playing by the modern rules, one that does not is legacy.
 * The two method names that only exist in one era each settle it on their own.
 */
export function detectRegime(req: MCPRequest, headers: http.IncomingHttpHeaders): Regime {
  if (req.method === 'initialize') return 'legacy';

  // The discriminator is the header's *value*, not its presence. Revisions 2025-06-18 and
  // 2025-11-25 also require MCP-Protocol-Version on every post-handshake request, so keying
  // on presence alone would route those clients into modern validation and reject them for
  // not sending Mcp-Method — breaking the two newest revisions Pylon advertises.
  // Decoded the same way validateModernHeaders decodes it: comparing the raw sentinel here
  // while decoding it there would route an encoded modern request into the legacy path and
  // hand it legacy-shaped results.
  const version = headerValue(headers, 'mcp-protocol-version');
  // A recognized legacy version routes to legacy, as before. Anything else present — the exact
  // modern version, or a value in neither list — routes to modern instead of falling through to
  // the silent legacy default below: only the modern path's validateModernHeaders actually
  // checks the header against SUPPORTED_VERSIONS and can answer an unrecognized version with
  // ERR_UNSUPPORTED_VERSION (-32022), so an unknown version must reach it rather than be
  // silently treated as an (unnegotiated) legacy request with no error at all.
  if (version !== undefined && !(LEGACY_VERSIONS as readonly string[]).includes(version)) {
    return 'modern';
  }

  // server/discover exists only in the modern revision, and a client calls it precisely
  // because it does not yet know which versions this server speaks — so it must work before
  // any version has been agreed on.
  if (req.method === 'server/discover') return 'modern';

  return 'legacy';
}

/**
 * Check the modern revision's required headers against the body.
 *
 * The spec mirrors `method`, `params.name`/`params.uri` and the protocol version into headers
 * so intermediaries can route without parsing the body — and then requires the server to
 * verify they agree, precisely so a proxy routing on the header and a server acting on the
 * body can never be made to disagree.
 *
 * @returns a ProtocolError when the request must be refused, otherwise null.
 */
export function validateModernHeaders(
  req: MCPRequest,
  headers: http.IncomingHttpHeaders,
): ProtocolError | null {
  const headerVersion = headerValue(headers, 'mcp-protocol-version');
  if (headerVersion === undefined) {
    // The one method that must work without headers: it is the bootstrap a client uses to
    // find out what this server speaks. Demanding a version header here would make the
    // supported-version list unreachable through the only method that publishes it.
    if (req.method === 'server/discover') return null;
    return mismatch('MCP-Protocol-Version header is required');
  }

  const meta = req.params?._meta as Record<string, unknown> | undefined;
  const bodyVersion = meta?.[META_PROTOCOL_VERSION];
  if (typeof bodyVersion === 'string' && bodyVersion !== headerVersion) {
    return mismatch(
      `MCP-Protocol-Version header "${headerVersion}" does not match _meta value "${bodyVersion}"`,
    );
  }

  if (!(SUPPORTED_VERSIONS as readonly string[]).includes(headerVersion)) {
    return {
      httpStatus: 400,
      code: ERR_UNSUPPORTED_VERSION,
      message: 'Unsupported protocol version',
      data: { supported: SUPPORTED_VERSIONS, requested: headerVersion },
    };
  }

  const headerMethod = headerValue(headers, 'mcp-method');
  if (headerMethod === undefined) {
    return mismatch('Mcp-Method header is required');
  }
  if (headerMethod !== req.method) {
    return mismatch(`Mcp-Method header "${headerMethod}" does not match body method "${req.method}"`);
  }

  // Mcp-Name mirrors params.name for tools/call and prompts/get, params.uri for resources/read.
  if (req.method === 'tools/call' || req.method === 'prompts/get' || req.method === 'resources/read') {
    const expected =
      req.method === 'resources/read'
        ? (req.params?.uri as string | undefined)
        : (req.params?.name as string | undefined);
    const headerName = headerValue(headers, 'mcp-name');
    if (headerName === undefined) {
      return mismatch(`Mcp-Name header is required for ${req.method}`);
    }
    if (expected !== undefined && headerName !== expected) {
      return mismatch(`Mcp-Name header "${headerName}" does not match body value "${expected}"`);
    }
  }

  return null;
}

function mismatch(message: string): ProtocolError {
  return { httpStatus: 400, code: ERR_HEADER_MISMATCH, message: `Header mismatch: ${message}` };
}

/**
 * The version to answer an `initialize` with.
 *
 * Echoing what the client asked for, when Pylon supports it, instead of always claiming the
 * oldest revision — which silently downgraded every client that asked for something newer.
 */
export function negotiateLegacyVersion(requested: unknown): string {
  return typeof requested === 'string' && (LEGACY_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LEGACY_VERSIONS[LEGACY_VERSIONS.length - 1];
}

export interface ServerIdentity {
  name: string;
  version: string;
}

/** The `server/discover` result. Servers MUST implement this method in the modern revision. */
export function discoverResult(
  identity: ServerIdentity,
  instructions: string,
): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: SUPPORTED_VERSIONS,
    // No listChanged on tools: nothing emits notifications/tools/list_changed yet, and
    // promising it would have clients trust a cached list across a disabledTools change.
    // Resources do support subscriptions — that is what subscriptions/listen serves.
    capabilities: { tools: {}, resources: { subscribe: true } },
    instructions,
    ttlMs: 3_600_000,
    cacheScope: 'public',
    _meta: { [META_SERVER_INFO]: identity },
  };
}

/** The legacy `initialize` result. */
export function initializeResult(
  requestedVersion: unknown,
  identity: ServerIdentity,
): Record<string, unknown> {
  return {
    protocolVersion: negotiateLegacyVersion(requestedVersion),
    capabilities: { tools: {} },
    serverInfo: identity,
  };
}

/**
 * Add the fields the modern revision requires, and only there.
 *
 * A legacy client negotiated a revision in which `resultType` does not exist; most tolerate
 * extra fields, strict schema validators do not. Since the regime is already known per
 * request, gating costs nothing and gives each era exactly its own contract.
 */
export function shapeResult(
  result: Record<string, unknown>,
  regime: Regime,
  identity: ServerIdentity,
  cache?: { ttlMs: number; cacheScope: 'public' | 'private' },
): Record<string, unknown> {
  if (regime === 'legacy') return result;
  const meta = (result._meta as Record<string, unknown> | undefined) ?? {};
  return {
    ...result,
    ...(cache ?? {}),
    resultType: 'complete',
    _meta: { ...meta, [META_SERVER_INFO]: identity },
  };
}

/** Notification types a client may opt into on a subscriptions/listen stream. */
export const SUBSCRIPTION_TYPES = [
  'toolsListChanged',
  'resourcesListChanged',
  'resourceSubscriptions',
] as const;

/** `_meta` key that tags every notification delivered on a listen stream. */
export const META_SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';

/** Resources Pylon exposes. Templates, since session and terminal names vary. */
export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'pylon://{session}/terminal/{name}/buffer',
    name: 'Terminal buffer',
    description: 'Buffered output of one terminal in one window.',
    mimeType: 'text/plain',
  },
  {
    uriTemplate: 'pylon://{session}/diagnostics',
    name: 'Diagnostics',
    description: 'Compiler and linter diagnostics for one window.',
    mimeType: 'text/plain',
  },
  {
    uriTemplate: 'pylon://{session}/debug/state',
    name: 'Debug state',
    description: 'Threads, stack frames and variables of the active debug session.',
    mimeType: 'text/plain',
  },
] as const;

/** The one fixed resource: the session registry itself. */
export const SESSIONS_RESOURCE = {
  uri: 'pylon://sessions',
  name: 'Sessions',
  description: 'VS Code windows currently reachable through this hub.',
  mimeType: 'text/plain',
} as const;

/** Which event kinds should wake which subscribed resource URI. */
export function resourceUriForEvent(kind: string, session: string, data: Record<string, unknown>): string | null {
  // Encoded, because both halves are user-chosen: a terminal called "Git Bash" or a session
  // disambiguated to "api#2" would otherwise produce a URI with a literal space or a fragment
  // marker, which does not survive a round trip through any client that normalizes it.
  const s = encodeURIComponent(session);
  if (kind.startsWith('terminal.')) {
    const name = typeof data.terminal === 'string' ? data.terminal : null;
    return name === null ? null : `pylon://${s}/terminal/${encodeURIComponent(name)}/buffer`;
  }
  if (kind === 'diagnostics.changed') return `pylon://${s}/diagnostics`;
  if (kind.startsWith('debug.')) return `pylon://${s}/debug/state`;
  return null;
}

/** Whether a JSON-RPC message is a notification (no id) and so must not be answered. */
export function isNotification(req: MCPRequest): boolean {
  // A batch is an array, and neither `method` nor `id` exists on it. Treating that as a
  // notification would answer 202 with no body and leave every id in the batch unanswered.
  if (Array.isArray(req) || typeof req?.method !== 'string') return false;

  // JSON-RPC 2.0: "A Notification is a Request object without an 'id' member." The method
  // name does not enter into it — a client that stamps an id on `notifications/initialized`
  // is waiting for a response, and one that omits it on `tools/list` is not. An explicit
  // `id: null` counts as present: the caller expects a reply carrying that same null.
  return req.id === undefined;
}
