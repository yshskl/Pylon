/**
 * Tool definitions advertised by the hub via tools/list.
 *
 * Pure data, no imports — kept out of hubServer.ts so the protocol code there stays readable.
 * To add a tool: add an entry here, then a matching `case` in AgentServer.callTool.
 */

export const SESSION_ID_PROP = {
  session_id: {
    type: 'string',
    description:
      'Target session ID (workspace name). Use terminal_list_sessions to discover available sessions. Omit to target the hub window.',
  },
};

export const SESSION_ID_NOTE =
  'Always include session_id (obtained from terminal_list_sessions) to target the correct VSCode window.';

export const HUB_TOOLS = [
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
      'Execute a shell command in a VS Code terminal and capture output. Requires shell integration.\n' +
      'Blocks until the command finishes or timeout_ms elapses (default 300000 = 5 min). Output ' +
      'streams live via progress notifications while blocking. On timeout, the command keeps running ' +
      'and the response ends with \'[STILL RUNNING — ...]\' — call terminal_wait to resume.\n' +
      'For commands expected to exceed ~30s (builds, installs, long tests), prefer wait=false + ' +
      'progressive terminal_wait calls starting at timeout_ms=10000 then 30000. Between waits you ' +
      'can read partial output, send input with terminal_send_text, or abort with \'\\x03\'.\n' +
      'If the target terminal is busy (Pylon- OR user-typed command still running), this call refuses ' +
      'with an error naming the active command. Pick a different terminal or call terminal_wait first.\n' +
      'Returns final output with \'[exit code: N]\' on success.\n' +
      'Note: on very short timeouts (<3s), the first return may show "(no output yet)" ' +
      'due to shell-integration chunk delivery lag; call terminal_wait to retrieve the ' +
      'actual output. ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        terminal_name: {
          type: 'string',
          description: 'Name of target terminal (optional, uses active terminal if omitted)',
        },
        timeout_ms: { type: 'number', description: 'Hard timeout in milliseconds (default: 300000 = 5 min). On timeout, the command keeps running — use terminal_wait to continue retrieving output.' },
        wait: { type: 'boolean', description: 'Wait for output (default: true). Set false to start the command and return immediately without capturing output.' },
        ...SESSION_ID_PROP,
      },
      required: ['command'],
    },
  },
  {
    name: 'terminal_send_text',
    description:
      'Send text/input to a terminal WITHOUT capturing output. Works on busy terminals — this is ' +
      'how you answer prompts in a running command or abort it (send \'\\x03\' for Ctrl+C, ' +
      '\'\\x04\' for Ctrl+D). Use terminal_wait afterward to retrieve the result of the ' +
      'interrupted command. ' + SESSION_ID_NOTE,
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
      'Read raw buffered output from a terminal (no exit code, includes user-typed ' +
      'command output too). For commands started via terminal_run(wait=false), ' +
      'prefer terminal_wait to retrieve output + exit code. ' +
      'Use terminal_read_output for tailing long-running processes (dev servers, watchers) ' +
      'where you just want a snapshot of what has been printed. ' +
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
    name: 'terminal_wait',
    description:
      'Wait for the current (or most recent) execution in a terminal to finish, and return its ' +
      'output and exit code. Blocks up to timeout_ms (default 300000). On timeout, returns output ' +
      'accumulated during this wait with \'[STILL RUNNING — ...]\' — call again to continue waiting, ' +
      'or send \'\\x03\' via terminal_send_text to abort. ' +
      'Use this to retrieve results after terminal_run(wait=false), to progressively check on a ' +
      'long-running command, or to wait for a user-typed command in a shared terminal. ' +
      'If the terminal has no active execution but one finished within the last 60s, returns that ' +
      'cached result. Otherwise errors. ' + SESSION_ID_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        terminal_name: { type: 'string', description: 'Name of target terminal (required).' },
        timeout_ms: { type: 'number', description: 'Max milliseconds to block (default: 300000).' },
        ...SESSION_ID_PROP,
      },
      required: ['terminal_name'],
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
