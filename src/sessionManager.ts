import { httpGet, httpPost } from './http';

/**
 * Registration and heartbeat are local, tiny, and on a timer — if one cannot complete in this
 * window the hub is effectively gone, and waiting longer only delays the failover.
 */
const REQUEST_TIMEOUT_MS = 4000;

export class SessionManager {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sessionId: string;
  private agentUrl: string;
  private onHubLost: () => Promise<void>;

  constructor(sessionId: string, agentUrl: string, onHubLost: () => Promise<void>) {
    this.sessionId = sessionId;
    this.agentUrl = agentUrl;
    this.onHubLost = onHubLost;
  }

  /**
   * Whether a Pylon hub — not just any listener — holds the port.
   *
   * A bare "did something answer" check makes every window a satellite of an unrelated dev
   * server that happens to sit on 27681, after which no window ever becomes hub and no tool
   * call routes anywhere.
   */
  static async discoverHub(hubPort = 27681): Promise<boolean> {
    try {
      const body = await httpGet(`http://127.0.0.1:${hubPort}/health`);
      return (JSON.parse(body) as { role?: string }).role === 'hub';
    } catch {
      return false;
    }
  }

  async registerWithHub(hubPort = 27681): Promise<void> {
    const raw = await httpPost(
      `http://127.0.0.1:${hubPort}/sessions/register`,
      { sessionId: this.sessionId, agentUrl: this.agentUrl },
      REQUEST_TIMEOUT_MS,
    );
    // The hub may hand back a different id when this window's workspace name collides with
    // one already registered. Adopting it matters: heartbeats and tool routing both address
    // the session by name, so keeping the requested one would beat against a row that is not
    // ours and get 404s forever.
    try {
      const assigned = (JSON.parse(raw) as { sessionId?: unknown }).sessionId;
      if (typeof assigned === 'string' && assigned.length > 0) this.sessionId = assigned;
    } catch {
      // An older hub answers {ok:true} with no id; the requested one stands.
    }
  }

  /** The id this window is actually registered under — may differ from the one requested. */
  get effectiveSessionId(): string {
    return this.sessionId;
  }

  startHeartbeat(hubPort = 27681, intervalMs = 5000): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      try {
        await httpPost(
          `http://127.0.0.1:${hubPort}/sessions/heartbeat`,
          { sessionId: this.sessionId },
          REQUEST_TIMEOUT_MS,
        );
      } catch {
        // Any failure means this window is no longer a registered satellite — the hub is gone
        // (connection refused), or it is alive but has forgotten us (404, e.g. after it was
        // promoted with an empty registry). Both are recovered the same way: stop beating and
        // let onHubLost try to promote, falling back to re-registering with whoever holds the
        // port. Until httpPost started rejecting on non-2xx, the 404 case resolved as success
        // and the window heartbeat into the void forever, invisible to every agent.
        this.stopHeartbeat();
        await this.onHubLost();
      }
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Tell the hub this window is going away, best-effort. */
  async unregister(hubPort = 27681): Promise<void> {
    try {
      await httpPost(
        `http://127.0.0.1:${hubPort}/sessions/unregister`,
        { sessionId: this.sessionId },
        1000,
      );
    } catch {
      // The hub may already be gone — the staleness sweep covers that case.
    }
  }

  dispose(): void {
    this.stopHeartbeat();
  }
}
