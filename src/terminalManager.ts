import * as vscode from 'vscode';

export interface TerminalInfo {
  id: number;
  name: string;
  isActive: boolean;
  hasShellIntegration: boolean;
}

export interface CommandResult {
  output: string;
  exitCode: number | undefined;
  timedOut: boolean;
}

interface ExecutionState {
  execution: vscode.TerminalShellExecution;
  terminalName: string;
  commandLine: string;
  startedAt: number;
  output: string;
  deliveredLength: number;
  endPromise: Promise<number | undefined>;
  resolveEnd: (exitCode: number | undefined) => void;
  finishedAt?: number;  // set by the generic end-listener when the execution ends
}

interface RecentResult {
  undeliveredOutput: string;
  exitCode: number | undefined;
  finishedAt: number;
}

const RECENT_RESULT_TTL_MS = 60_000;
const END_EVENT_WAIT_MS = 2000;

class OutputBuffer {
  private lines: string[] = [];
  private maxLines: number;
  private partial = '';

  constructor(maxLines: number) {
    this.maxLines = maxLines;
  }

  append(data: string): void {
    const cleaned = data.replace(
      // eslint-disable-next-line no-control-regex
      /\x1b(?:\[[0-9;]*[mGKHFABCDEJsupr]|\][^\x07]*\x07|[()][AB012])|[\r]/g,
      ''
    );
    const all = this.partial + cleaned;
    // Guard against runaway partial (e.g. binary output with no newlines)
    if (all.length > 512 * 1024) {
      this.partial = '';
      return;
    }
    const parts = all.split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) {
      this.lines.push(line);
      if (this.lines.length > this.maxLines) {
        this.lines.shift();
      }
    }
  }

  flush(): void {
    if (this.partial) {
      this.lines.push(this.partial);
      this.partial = '';
    }
  }

  getLines(count?: number): string[] {
    if (count === undefined) return [...this.lines];
    return this.lines.slice(-count);
  }

  clear(): void {
    this.lines = [];
    this.partial = '';
  }

  get lineCount(): number {
    return this.lines.length;
  }
}

export class TerminalManager {
  private outputBuffers = new Map<string, OutputBuffer>();
  private disposables: vscode.Disposable[] = [];
  private maxBufferLines: number;
  // Track executions we started so the passive listener skips them (we buffer directly)
  private ownExecutions = new Set<vscode.TerminalShellExecution>();
  private activeExecutions = new Map<string, ExecutionState>();
  private recentResults = new Map<string, RecentResult>();

  constructor(maxBufferLines: number) {
    this.maxBufferLines = maxBufferLines;
    this.setupListeners();
  }

  private getBuffer(terminal: vscode.Terminal): OutputBuffer {
    const key = terminal.name;
    if (!this.outputBuffers.has(key)) {
      this.outputBuffers.set(key, new OutputBuffer(this.maxBufferLines));
    }
    return this.outputBuffers.get(key)!;
  }

  private registerExecution(
    e: { terminal: vscode.Terminal; execution: vscode.TerminalShellExecution },
    commandLine: string
  ): ExecutionState {
    let resolveEnd!: (exitCode: number | undefined) => void;
    const endPromise = new Promise<number | undefined>((resolve) => { resolveEnd = resolve; });
    const state: ExecutionState = {
      execution: e.execution,
      terminalName: e.terminal.name,
      commandLine,
      startedAt: Date.now(),
      output: '',
      deliveredLength: 0,
      endPromise,
      resolveEnd,
    };
    this.activeExecutions.set(e.terminal.name, state);
    return state;
  }

  private setupListeners(): void {
    // Passively buffer output from user-typed commands when shell integration is active.
    // onDidWriteTerminalData is a proposed API (blocked for packaged extensions), so we
    // rely on shell integration events for buffering instead.
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        if (this.ownExecutions.has(e.execution)) {
          return; // executeCommand handles buffering + registration for its own executions
        }
        const commandLine = e.execution.commandLine?.value ?? '<user-typed command>';
        const state = this.registerExecution(e, commandLine);
        const buf = this.getBuffer(e.terminal);
        for await (const chunk of e.execution.read()) {
          buf.append(chunk);
          state.output += chunk;
        }
      })
    );

    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution((e) => {
        const state = this.activeExecutions.get(e.terminal.name);
        if (!state || state.execution !== e.execution) return;
        this.activeExecutions.delete(e.terminal.name);
        state.resolveEnd(e.exitCode);
        const finishedAt = Date.now();
        state.finishedAt = finishedAt;
        const undeliveredOutput = state.output.slice(state.deliveredLength);
        this.recentResults.set(e.terminal.name, {
          undeliveredOutput,
          exitCode: e.exitCode,
          finishedAt,
        });
        setTimeout(() => {
          // Only expire if this exact entry is still the current cached result.
          // If a newer execution finished and replaced the entry in the meantime,
          // its own TTL timer will handle expiry.
          const current = this.recentResults.get(e.terminal.name);
          if (current && current.finishedAt === finishedAt) {
            this.recentResults.delete(e.terminal.name);
          }
        }, RECENT_RESULT_TTL_MS);
      })
    );

    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        this.outputBuffers.get(terminal.name)?.flush();
        this.outputBuffers.delete(terminal.name);
        const state = this.activeExecutions.get(terminal.name);
        if (state) {
          this.activeExecutions.delete(terminal.name);
          state.resolveEnd(undefined);
        }
        this.recentResults.delete(terminal.name);
      })
    );
  }

  listTerminals(): TerminalInfo[] {
    const active = vscode.window.activeTerminal;
    return vscode.window.terminals.map((t, i) => ({
      id: i,
      name: t.name,
      isActive: t === active,
      hasShellIntegration: !!t.shellIntegration,
    }));
  }

  getOrCreateTerminal(name?: string): vscode.Terminal {
    if (name) {
      const existing = vscode.window.terminals.find((t) => t.name === name);
      if (existing) return existing;
      // Resolve shell profile from the name so "PowerShell" actually opens PowerShell
      const resolved = this.resolveShellProfile(name);
      if (resolved) {
        return vscode.window.createTerminal({ name, shellPath: resolved.shellPath, shellArgs: resolved.shellArgs });
      }
      return vscode.window.createTerminal(name);
    }
    return vscode.window.activeTerminal ?? vscode.window.createTerminal('Terminal');
  }

  /**
   * Attempt to resolve a terminal name to an actual shell executable.
   * Checks user-configured terminal profiles first, then falls back to well-known defaults.
   */
  private resolveShellProfile(name: string): { shellPath: string; shellArgs?: string[] } | undefined {
    const lower = name.toLowerCase();

    // Check VS Code terminal profiles (user/workspace settings)
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const profiles = vscode.workspace.getConfiguration('terminal.integrated.profiles').get<Record<string, { path?: string | string[]; args?: string[]; source?: string }>>(platform);
    if (profiles) {
      for (const [profileName, profile] of Object.entries(profiles)) {
        if (profileName.toLowerCase() === lower && profile) {
          if (profile.path) {
            const shellPath = Array.isArray(profile.path) ? profile.path[0] : profile.path;
            return { shellPath, shellArgs: profile.args };
          }
          // "source" profiles (e.g. source: "PowerShell") — fall through to well-known map
        }
      }
    }

    // Well-known shell name → executable mapping
    const SHELL_MAP: Record<string, { shellPath: string; shellArgs?: string[] }> = {
      'powershell': { shellPath: process.platform === 'win32' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'pwsh' },
      'pwsh': { shellPath: 'pwsh' },
      'cmd': { shellPath: 'C:\\Windows\\System32\\cmd.exe' },
      'command prompt': { shellPath: 'C:\\Windows\\System32\\cmd.exe' },
      'bash': { shellPath: process.platform === 'win32' ? 'C:\\Windows\\System32\\bash.exe' : 'bash' },
      'wsl': { shellPath: process.platform === 'win32' ? 'C:\\Windows\\System32\\wsl.exe' : 'bash' },
      'zsh': { shellPath: 'zsh' },
      'fish': { shellPath: 'fish' },
      'git bash': { shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    };

    for (const [key, value] of Object.entries(SHELL_MAP)) {
      if (lower.includes(key)) {
        return value;
      }
    }

    return undefined;
  }

  private busyError(terminalName: string, state: ExecutionState): Error {
    return new Error(
      `Terminal '${terminalName}' is busy running: ${state.commandLine}. ` +
      `Use terminal_wait to wait for completion, terminal_send_text to provide input ` +
      `(send '\\x03' to abort), or target a different terminal.`
    );
  }

  async executeCommand(
    command: string,
    terminalName?: string,
    timeoutMs = 300_000,
    onChunk?: (chunk: string) => void
  ): Promise<CommandResult> {
    const terminal = this.getOrCreateTerminal(terminalName);

    const existing = this.activeExecutions.get(terminal.name);
    if (existing) {
      throw this.busyError(terminal.name, existing);
    }

    terminal.show(true);

    if (!terminal.shellIntegration) {
      await this.waitForShellIntegration(terminal, 8000);
    }

    if (!terminal.shellIntegration) {
      terminal.sendText(command);
      return {
        output:
          '[Shell integration unavailable — command sent via sendText. terminal_wait ' +
          'and exit codes won\'t work for this terminal.\n' +
          'Enable: terminal.integrated.shellIntegration.enabled = true]',
        exitCode: undefined,
        timedOut: false,
      };
    }

    const execution = terminal.shellIntegration.executeCommand(command);
    this.ownExecutions.add(execution);

    const state = this.registerExecution({ terminal, execution }, command);

    const buf = this.getBuffer(terminal);

    const readPromise = (async () => {
      for await (const chunk of execution.read()) {
        state.output += chunk;
        buf.append(chunk);
        if (onChunk) onChunk(chunk);
      }
    })();
    // Attach a no-op handler so a mid-iteration rejection doesn't surface as
    // UnhandledPromiseRejection if we return via the timeout path before `await`ing this.
    readPromise.catch(() => {});

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const outcome = await Promise.race([
      readPromise.then(() => 'done' as const),
      timeoutPromise,
    ]);

    if (timeoutHandle) clearTimeout(timeoutHandle);

    this.ownExecutions.delete(execution);

    if (outcome === 'done') {
      // The generic end-listener resolves endPromise when onDidEndTerminalShellExecution
      // fires. VS Code does not guarantee the end event precedes read-iterator completion,
      // so wait up to END_EVENT_WAIT_MS for it before giving up and returning undefined.
      const exitCode = await Promise.race([
        state.endPromise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), END_EVENT_WAIT_MS)),
      ]);
      const slice = state.output.slice(state.deliveredLength);
      state.deliveredLength = state.output.length;
      // The generic end-listener wrote recentResults for *this* execution; we already
      // delivered its content via the slice above. Delete only if the cached entry is
      // still the one our generic listener wrote — identified by matching finishedAt.
      const recent = this.recentResults.get(terminal.name);
      if (recent && state.finishedAt !== undefined && recent.finishedAt === state.finishedAt) {
        this.recentResults.delete(terminal.name);
      }
      return {
        output: cleanShellOutput(slice) || '(no output)',
        exitCode,
        timedOut: false,
      };
    }

    // Timeout: command keeps running, terminal stays busy.
    const slice = state.output.slice(state.deliveredLength);
    state.deliveredLength = state.output.length;
    const cleaned = cleanShellOutput(slice);
    const body = cleaned || '(no output yet)';
    return {
      output:
        `${body}\n\n[STILL RUNNING — ${Math.round(timeoutMs / 1000)}s elapsed, no exit yet. ` +
        `Call terminal_wait (terminal_name='${terminal.name}') to continue waiting, ` +
        `or send '\\x03' via terminal_send_text to abort.]`,
      exitCode: undefined,
      timedOut: true,
    };
  }

  sendText(text: string, terminalName?: string, addNewline = true): string {
    const terminal = this.getOrCreateTerminal(terminalName);
    terminal.show(true);
    terminal.sendText(text, addNewline);
    return terminal.name;
  }

  readOutput(terminalName?: string, lines?: number): string {
    let terminal: vscode.Terminal | undefined;

    if (terminalName) {
      terminal = vscode.window.terminals.find((t) => t.name === terminalName);
      if (!terminal) {
        const names = vscode.window.terminals.map((t) => `"${t.name}"`).join(', ');
        throw new Error(`Terminal "${terminalName}" not found. Open: ${names || 'none'}`);
      }
    } else {
      terminal =
        vscode.window.activeTerminal ??
        vscode.window.terminals[vscode.window.terminals.length - 1];
      if (!terminal) throw new Error('No terminals open');
    }

    const buf = this.outputBuffers.get(terminal.name);
    if (!buf || buf.lineCount === 0) {
      return (
        '[No buffered output yet. Output is captured via shell integration — run a\n' +
        'command in the terminal (or use terminal_run) to populate the buffer.\n' +
        'If shell integration is disabled, enable it in VS Code settings:\n' +
        'terminal.integrated.shellIntegration.enabled = true]'
      );
    }

    return buf.getLines(lines).join('\n');
  }

  clearBuffer(terminalName?: string): void {
    if (terminalName) {
      this.outputBuffers.get(terminalName)?.clear();
    } else {
      const t = vscode.window.activeTerminal;
      if (t) this.outputBuffers.get(t.name)?.clear();
    }
  }

  private waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (terminal.shellIntegration) { resolve(); return; }
      const timer = setTimeout(resolve, timeoutMs);
      const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
      });
    });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.outputBuffers.clear();
  }
}

function cleanShellOutput(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*[mGKHFABCDEJsupr]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\r/g, '')
    .trim();
}
