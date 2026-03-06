import * as http from 'http';

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

  static async discoverHub(hubPort = 27681): Promise<boolean> {
    try {
      await httpGet(`http://127.0.0.1:${hubPort}/health`);
      return true;
    } catch {
      return false;
    }
  }

  async registerWithHub(hubPort = 27681): Promise<void> {
    await httpPost(`http://127.0.0.1:${hubPort}/sessions/register`, {
      sessionId: this.sessionId,
      agentUrl: this.agentUrl,
    });
  }

  startHeartbeat(hubPort = 27681, intervalMs = 5000): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      try {
        await httpPost(`http://127.0.0.1:${hubPort}/sessions/heartbeat`, {
          sessionId: this.sessionId,
        });
      } catch {
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

  dispose(): void {
    this.stopHeartbeat();
  }
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

export function httpPost(url: string, body: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: parseInt(urlObj.port, 10),
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
