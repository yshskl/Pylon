import * as http from 'http';
import * as vscode from 'vscode';
import { TerminalManager } from './terminalManager';

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

export class AgentServer {
  private server: http.Server | null = null;
  private terminalManager: TerminalManager;
  port = 0;

  constructor(terminalManager: TerminalManager) {
    this.terminalManager = terminalManager;
  }

  start(basePort = 27691): Promise<number> {
    const MAX_ATTEMPTS = 10;
    const tryPort = (attempt: number): Promise<number> => {
      if (attempt >= MAX_ATTEMPTS) {
        return Promise.reject(
          new Error(`No available agent port in range ${basePort}–${basePort + MAX_ATTEMPTS - 1}`)
        );
      }
      const candidatePort = basePort + attempt;
      return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

          if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

          if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
          }

          if (req.method === 'POST' && req.url === '/tool') {
            let body = '';
            let bodySize = 0;
            const MAX_BODY = 1024 * 1024; // 1 MB
            req.on('data', (chunk) => {
              bodySize += chunk.length;
              if (bodySize <= MAX_BODY) { body += chunk; }
            });
            req.on('end', async () => {
              if (bodySize > MAX_BODY) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request body too large' }));
                return;
              }
              try {
                const { tool, params } = JSON.parse(body) as {
                  tool: string;
                  params: Record<string, unknown>;
                };
                const result = await this.callTool(tool, params);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
              } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: String(e) }));
              }
            });
            return;
          }

          res.writeHead(404);
          res.end();
        });

        server.on('error', (e: NodeJS.ErrnoException) => {
          server.close();
          if (e.code === 'EADDRINUSE') {
            tryPort(attempt + 1).then(resolve, reject);
          } else {
            reject(e);
          }
        });

        server.listen(candidatePort, '127.0.0.1', () => {
          this.server = server;
          this.port = candidatePort;
          resolve(candidatePort);
        });
      });
    };
    return tryPort(0);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => { this.server = null; resolve(); });
    });
  }

  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });

    switch (name) {
      case 'terminal_list': {
        const terminals = this.terminalManager.listTerminals();
        if (terminals.length === 0) return text('No terminals open.');
        const lines = terminals.map(
          (t) =>
            `[${t.id}] "${t.name}"${t.isActive ? ' (active)' : ''}${
              t.hasShellIntegration ? ' [shell-integration]' : ' [no shell-integration]'
            }`
        );
        return text(lines.join('\n'));
      }

      case 'terminal_run': {
        const command = args.command as string;
        const terminalName = args.terminal_name as string | undefined;
        const timeoutMs = (args.timeout_ms as number | undefined) ?? 30000;
        const result = await this.terminalManager.executeCommand(command, terminalName, timeoutMs);
        let response = result.output || '(no output)';
        if (result.timedOut) {
          response += `\n\n[TIMED OUT after ${timeoutMs}ms — command may still be running. Use terminal_read_output to read ongoing output.]`;
        }
        if (result.exitCode !== undefined) {
          response += `\n[exit code: ${result.exitCode}]`;
        }
        return text(response);
      }

      case 'terminal_send_text': {
        const rawText = args.text as string;
        const processed = rawText
          .replace(/\\x03/g, '\x03')
          .replace(/\\x04/g, '\x04')
          .replace(/\\n/g, '\n');
        const terminalName = args.terminal_name as string | undefined;
        const addNewline = (args.add_newline as boolean | undefined) ?? true;
        this.terminalManager.sendText(processed, terminalName, addNewline);
        return text(`Text sent to terminal${terminalName ? ` "${terminalName}"` : ''}.`);
      }

      case 'terminal_read_output': {
        const terminalName = args.terminal_name as string | undefined;
        const lines = args.lines as number | undefined;
        return text(this.terminalManager.readOutput(terminalName, lines));
      }

      case 'terminal_clear_buffer': {
        const terminalName = args.terminal_name as string | undefined;
        this.terminalManager.clearBuffer(terminalName);
        return text('Buffer cleared.');
      }

      case 'get_diagnostics': {
        const uri = args.uri as string | undefined;
        const severity = args.severity as string | undefined;

        const severityMap: Record<string, vscode.DiagnosticSeverity> = {
          error: vscode.DiagnosticSeverity.Error,
          warning: vscode.DiagnosticSeverity.Warning,
          information: vscode.DiagnosticSeverity.Information,
          hint: vscode.DiagnosticSeverity.Hint,
        };
        const severityNames: Record<number, string> = {
          [vscode.DiagnosticSeverity.Error]: 'Error',
          [vscode.DiagnosticSeverity.Warning]: 'Warning',
          [vscode.DiagnosticSeverity.Information]: 'Information',
          [vscode.DiagnosticSeverity.Hint]: 'Hint',
        };
        const filterSeverity = severity ? severityMap[severity] : undefined;

        let allDiagnostics: [vscode.Uri, vscode.Diagnostic[]][];
        if (uri) {
          const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
          const diags = vscode.languages.getDiagnostics(fileUri);
          allDiagnostics = diags.length > 0 ? [[fileUri, diags]] : [];
        } else {
          allDiagnostics = vscode.languages.getDiagnostics();
        }

        const lines: string[] = [];
        let totalCount = 0;

        for (const [fileUri, diagnostics] of allDiagnostics) {
          const filtered = filterSeverity !== undefined
            ? diagnostics.filter((d) => d.severity === filterSeverity)
            : diagnostics;
          if (filtered.length === 0) continue;

          const relPath = vscode.workspace.asRelativePath(fileUri);
          for (const d of filtered) {
            const sev = severityNames[d.severity] || 'Unknown';
            const line = d.range.start.line + 1;
            const col = d.range.start.character + 1;
            const source = d.source ? ` [${d.source}]` : '';
            lines.push(`${relPath}:${line}:${col} ${sev}${source}: ${d.message}`);
            totalCount++;
          }
        }

        if (totalCount === 0) {
          return text(uri ? `No diagnostics for ${uri}.` : 'No diagnostics found.');
        }
        return text(`${totalCount} diagnostic(s):\n\n${lines.join('\n')}`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
