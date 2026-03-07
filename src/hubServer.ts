import * as http from 'http';
import { AgentServer, ToolResult } from './agentServer';
import { httpPost } from './sessionManager';

interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface SessionEntry {
  agentUrl: string;
  lastSeen: number;
}

const STALE_MS = 15000;

const SESSION_ID_PROP = {
  session_id: {
    type: 'string',
    description:
      'Target session ID (workspace name). Use terminal_list_sessions to discover available sessions. Omit to target the hub window.',
  },
};

const SESSION_ID_NOTE =
  'Always include session_id (obtained from terminal_list_sessions) to target the correct VSCode window.';

const HUB_TOOLS = [
  {
    name: 'terminal_list_sessions',
    description:
      'CALL THIS FIRST before using any other terminal tools. ' +
      'Lists all connected VSCode windows with their session IDs (= workspace folder name). ' +
      'Identify your session by matching the workspace folder name visible in your current context, ' +
      'then remember that session_id and pass it to all subsequent terminal tool calls.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terminal_list',
    description:
      'List open VS Code terminals. Without session_id lists terminals across ALL sessions tagged by session name. ' +
      'With session_id lists terminals in that session only. ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: { ...SESSION_ID_PROP },
    },
  },
  {
    name: 'terminal_run',
    description:
      'Execute a shell command in a VS Code terminal. Captures and returns stdout/stderr. Requires shell integration. ' +
      'Use terminal_name to target a specific terminal by name. ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        terminal_name: {
          type: 'string',
          description: 'Name of target terminal (optional, uses active terminal if omitted)',
        },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
        ...SESSION_ID_PROP,
      },
      required: ['command'],
    },
  },
  {
    name: 'terminal_send_text',
    description:
      'Send text/input to a terminal WITHOUT capturing output. ' +
      'Use this to interact with running processes (e.g. answer prompts, send Ctrl+C via \\x03). ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to send. Use \\x03 for Ctrl+C, \\x04 for Ctrl+D.' },
        terminal_name: { type: 'string', description: 'Name of target terminal (optional)' },
        add_newline: { type: 'boolean', description: 'Whether to append newline (default: true)' },
        ...SESSION_ID_PROP,
      },
      required: ['text'],
    },
  },
  {
    name: 'terminal_read_output',
    description:
      'Read buffered output from a terminal. ' +
      'Captures ALL output including from long-running processes (dev servers, watchers, etc). ' +
      'Buffer is populated from the moment the extension started. ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        terminal_name: {
          type: 'string',
          description: 'Name of terminal to read (optional, uses active terminal if omitted)',
        },
        lines: {
          type: 'number',
          description: 'Number of last lines to return (optional, returns all buffered lines if omitted)',
        },
        ...SESSION_ID_PROP,
      },
    },
  },
  {
    name: 'terminal_clear_buffer',
    description: 'Clear the output buffer for a terminal (start fresh). ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        terminal_name: { type: 'string', description: 'Name of terminal (optional, uses active terminal)' },
        ...SESSION_ID_PROP,
      },
    },
  },
  {
    name: 'get_diagnostics',
    description:
      'Get VS Code diagnostics (errors, warnings, hints) from all open files or a specific file. ' +
      'Returns TypeScript errors, ESLint warnings, and any other diagnostics from installed language extensions. ' +
      'Useful after editing files to check for problems without running a build. ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'File path or URI to get diagnostics for (optional, returns all diagnostics if omitted)',
        },
        severity: {
          type: 'string',
          enum: ['error', 'warning', 'information', 'hint'],
          description: 'Filter by severity level (optional, returns all severities if omitted)',
        },
        ...SESSION_ID_PROP,
      },
    },
  },
  {
    name: 'get_document_symbols',
    description:
      'Get the symbol outline of a file (functions, classes, methods, variables, exports) without reading the entire file. ' +
      'Massive token savings when exploring codebases. Returns a hierarchical list of symbols with name, kind, and line range. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'File path or URI to get symbols for',
        },
        ...SESSION_ID_PROP,
      },
      required: ['uri'],
    },
  },
  {
    name: 'get_references',
    description:
      'Find all references (usages) of a symbol across the entire workspace. ' +
      'Critical for safe refactoring — understand blast radius before making changes. ' +
      'Returns a list of file locations where the symbol is used. ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'File path or URI containing the symbol',
        },
        line: {
          type: 'number',
          description: 'Line number (0-based) of the symbol',
        },
        character: {
          type: 'number',
          description: 'Column number (0-based) of the symbol',
        },
        ...SESSION_ID_PROP,
      },
      required: ['uri', 'line', 'character'],
    },
  },
  {
    name: 'rename_symbol',
    description:
      'Rename a symbol across the entire workspace using VS Code LSP. ' +
      'Updates all references including imports, re-exports, and type annotations. ' +
      'Use get_references first to understand impact, then rename. ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'File path or URI containing the symbol to rename',
        },
        line: {
          type: 'number',
          description: 'Line number (0-based) of the symbol',
        },
        character: {
          type: 'number',
          description: 'Column number (0-based) of the symbol',
        },
        new_name: {
          type: 'string',
          description: 'New name for the symbol',
        },
        ...SESSION_ID_PROP,
      },
      required: ['uri', 'line', 'character', 'new_name'],
    },
  },
  {
    name: 'run_command',
    description:
      'Execute any VS Code command by ID. Universal escape hatch — anything VS Code can do, the agent can trigger. ' +
      'Common examples: "editor.action.organizeImports" (fix imports), "editor.action.formatDocument" (format file), ' +
      '"workbench.action.closeActiveEditor" (close tab), "workbench.action.terminal.new" (new terminal). ' +
      'Use "workbench.action.showCommands" as a reference — any command from the Command Palette works here. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'VS Code command ID (e.g. "editor.action.formatDocument", "workbench.action.files.save")',
        },
        args: {
          type: 'array',
          description: 'Optional arguments to pass to the command',
          items: {},
        },
        ...SESSION_ID_PROP,
      },
      required: ['command'],
    },
  },
  // ── Editor Tools ──────────────────────────────────────────────
  {
    name: 'open_file',
    description:
      'Open a file in the VS Code editor and optionally jump to a line or highlight a range. ' +
      'The human will see the file appear in their editor — use this to draw attention to specific code. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path to open' },
        line: { type: 'number', description: 'Line number to jump to, 1-based (optional)' },
        end_line: { type: 'number', description: 'End line to highlight a range, 1-based (optional, requires line)' },
        ...SESSION_ID_PROP,
      },
      required: ['file'],
    },
  },
  {
    name: 'format_document',
    description:
      'Format a file using the configured formatter (Prettier, ESLint, etc.) and save it. ' +
      'Call this after editing files to ensure consistent code style. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path to format' },
        ...SESSION_ID_PROP,
      },
      required: ['file'],
    },
  },
  {
    name: 'organize_imports',
    description:
      'Remove unused imports and sort remaining imports in a file, then save. ' +
      'Call this after refactoring to clean up stale imports. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path to organize imports in' },
        ...SESSION_ID_PROP,
      },
      required: ['file'],
    },
  },
  {
    name: 'fix_all',
    description:
      'Apply all auto-fixable diagnostics in a file (ESLint auto-fixes, missing semicolons, etc.) and save. ' +
      'Run this after editing to resolve all issues that have automatic fixes. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path to auto-fix' },
        ...SESSION_ID_PROP,
      },
      required: ['file'],
    },
  },
  {
    name: 'save_all',
    description:
      'Save all open files with unsaved changes. ' +
      'The human will see all dirty-file indicators clear. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_ID_PROP,
      },
    },
  },
  {
    name: 'find_in_files',
    description:
      'Open the VS Code workspace search panel with a query. The human will see search results populate in the sidebar. ' +
      'Supports regex, file include/exclude globs, and optional replace. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        replace: { type: 'string', description: 'Replacement string (optional — opens find-and-replace if provided)' },
        is_regex: { type: 'boolean', description: 'Treat query as a regex (default: false)' },
        include: { type: 'string', description: 'Glob pattern for files to include (e.g. "src/**/*.ts")' },
        exclude: { type: 'string', description: 'Glob pattern for files to exclude (e.g. "node_modules/**")' },
        ...SESSION_ID_PROP,
      },
      required: ['query'],
    },
  },
  {
    name: 'get_hover_info',
    description:
      'Get type information, documentation, and signatures for a symbol at a specific position. ' +
      'Returns what you would see when hovering over a symbol in VS Code — type signatures, JSDoc, parameter docs. ' +
      'Use this to understand types without reading entire files. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'File path or URI' },
        line: { type: 'number', description: 'Line number (0-based)' },
        character: { type: 'number', description: 'Column number (0-based)' },
        ...SESSION_ID_PROP,
      },
      required: ['uri', 'line', 'character'],
    },
  },
  // ── Debug Tools ──────────────────────────────────────────────
  {
    name: 'debug_breakpoints',
    description:
      'Add, remove, list, or clear breakpoints. Works without an active debug session. ' +
      'Use "list" to see all current breakpoints, "add" to set a new one, "remove" to delete one, "clear" to remove all. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'list', 'clear'],
          description: 'Breakpoint operation to perform',
        },
        file: { type: 'string', description: 'File path (required for add/remove)' },
        line: { type: 'number', description: 'Line number, 1-based (required for add/remove)' },
        condition: { type: 'string', description: 'Conditional expression (optional, for add)' },
        hit_condition: { type: 'string', description: 'Hit count expression (optional, for add)' },
        log_message: { type: 'string', description: 'Log message — makes it a logpoint (optional, for add)' },
        ...SESSION_ID_PROP,
      },
      required: ['action'],
    },
  },
  {
    name: 'debug_start',
    description:
      'Start a debug session. Provide either a launch.json config name or an inline config object. ' +
      'If neither is given, launches the default configuration. ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of a launch.json configuration to run' },
        config: {
          type: 'object',
          description:
            'Inline debug configuration object (e.g. { "type": "node", "request": "launch", "program": "${workspaceFolder}/app.js" })',
        },
        ...SESSION_ID_PROP,
      },
    },
  },
  {
    name: 'debug_stop',
    description:
      'Stop a debug session. By default stops the active session; set all=true to stop every session. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Stop all debug sessions (default: false)' },
        clear_breakpoints: { type: 'boolean', description: 'Clear all breakpoints after stopping (default: false)' },
        ...SESSION_ID_PROP,
      },
    },
  },
  {
    name: 'debug_state',
    description:
      'Get a full snapshot of the current debug state: threads, call stacks, scopes, and variables — all in one call. ' +
      'No need to chain thread→frame→scope→variable requests. ' +
      'Returns everything needed to understand program state at a breakpoint. ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'number', description: 'Specific thread ID (optional, returns all threads if omitted)' },
        max_depth: { type: 'number', description: 'Max variable nesting depth to expand (default: 1)' },
        ...SESSION_ID_PROP,
      },
    },
  },
  {
    name: 'debug_control',
    description:
      'Control execution of a debug session: continue, pause, step over/into/out, restart, or evaluate expressions. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['continue', 'pause', 'next', 'stepIn', 'stepOut', 'restart', 'evaluate'],
          description: 'Debug action to perform',
        },
        thread_id: { type: 'number', description: 'Thread ID (optional, uses first thread)' },
        expression: { type: 'string', description: 'Expression to evaluate (required for "evaluate" action)' },
        frame_id: { type: 'number', description: 'Frame ID for evaluation context (optional)' },
        context: {
          type: 'string',
          enum: ['watch', 'repl', 'hover'],
          description: 'Evaluation context (default: repl)',
        },
        ...SESSION_ID_PROP,
      },
      required: ['action'],
    },
  },
  {
    name: 'debug_console_output',
    description:
      'Read debug console output (console.log, stderr, debugger messages) from the current or most recent debug session. ' +
      'This captures DAP output events that are NOT available via terminal tools. ' +
      'Use this to see what the debugged program prints. ' +
      SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'number',
          description: 'Number of last lines to return (optional, returns all buffered output if omitted)',
        },
        clear: {
          type: 'boolean',
          description: 'Clear the buffer after reading (default: false)',
        },
        ...SESSION_ID_PROP,
      },
    },
  },
];

export class HubServer {
  private server: http.Server | null = null;
  private ownAgent: AgentServer;
  private ownSessionId: string;
  private sessions = new Map<string, SessionEntry>();
  readonly port: number;

  constructor(ownAgent: AgentServer, ownSessionId: string, port = 27681) {
    this.ownAgent = ownAgent;
    this.ownSessionId = ownSessionId;
    this.port = port;
    this.sessions.set(ownSessionId, {
      agentUrl: `http://127.0.0.1:${ownAgent.port}`,
      lastSeen: Date.now(),
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(this.createHandler());
      server.on('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        resolve();
      });
    });
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

  registerSession(sessionId: string, agentUrl: string): void {
    this.sessions.set(sessionId, { agentUrl, lastSeen: Date.now() });
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

  private pruneStaleSessions(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (id !== this.ownSessionId && now - s.lastSeen > STALE_MS) {
        this.sessions.delete(id);
      }
    }
  }

  private createHandler() {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', role: 'hub', sessionId: this.ownSessionId }));
        return;
      }

      if (req.method === 'POST' && req.url === '/sessions/register') {
        this.parseBody(req, res, (body) => {
          const { sessionId, agentUrl } = body as { sessionId: string; agentUrl: string };
          this.registerSession(sessionId, agentUrl);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
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

      if (req.method === 'POST' && req.url === '/mcp') {
        this.parseBody(req, res, async (body) => {
          const response = await this.handleMCPRequest(body as MCPRequest);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
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
        await handler(JSON.parse(body));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  }

  private async handleMCPRequest(req: MCPRequest): Promise<MCPResponse> {
    const base = { jsonrpc: '2.0' as const, id: req.id };
    try {
      switch (req.method) {
        case 'initialize':
          return {
            ...base,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'pylon', version: '0.2.0' }, // keep in sync with package.json
            },
          };

        case 'tools/list':
          return { ...base, result: { tools: HUB_TOOLS } };

        case 'tools/call': {
          const params = req.params as { name: string; arguments: Record<string, unknown> };
          const result = await this.routeToolCall(params.name, params.arguments ?? {});
          return { ...base, result };
        }

        case 'notifications/initialized':
          return { ...base, result: {} };

        default:
          return { ...base, error: { code: -32601, message: `Method not found: ${req.method}` } };
      }
    } catch (e) {
      return { ...base, error: { code: -32603, message: String(e) } };
    }
  }

  private async routeToolCall(
    name: string,
    args: Record<string, unknown>
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

    // Aggregate terminal_list across all sessions when no session_id given
    if (name === 'terminal_list' && !sessionId) {
      this.pruneStaleSessions();
      const parts: string[] = [];
      for (const [sid, session] of this.sessions) {
        try {
          const result =
            sid === this.ownSessionId
              ? await this.ownAgent.callTool('terminal_list', args)
              : await forwardToAgent(session.agentUrl, 'terminal_list', args);
          const lines = result.content[0].text
            .split('\n')
            .map((l) => `[${sid}] ${l}`);
          parts.push(...lines);
        } catch {
          parts.push(`[${sid}] (unreachable)`);
        }
      }
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
      return await forwardToAgent(session.agentUrl, name, args);
    }

    // Handle locally (hub's own window)
    return await this.ownAgent.callTool(name, args);
  }
}

async function forwardToAgent(
  agentUrl: string,
  tool: string,
  params: Record<string, unknown>
): Promise<ToolResult> {
  const raw = await httpPost(`${agentUrl}/tool`, { tool, params });
  return JSON.parse(raw) as ToolResult;
}
