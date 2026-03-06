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

  private setupListeners(): void {
    // Passively buffer output from user-typed commands when shell integration is active.
    // onDidWriteTerminalData is a proposed API (blocked for packaged extensions), so we
    // rely on shell integration events for buffering instead.
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        if (this.ownExecutions.has(e.execution)) {
          return; // executeCommand handles buffering for its own executions
        }
        const buf = this.getBuffer(e.terminal);
        for await (const chunk of e.execution.read()) {
          buf.append(chunk);
        }
      })
    );

    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        // Flush partial line then remove — buffer is inaccessible after terminal closes
        this.outputBuffers.get(terminal.name)?.flush();
        this.outputBuffers.delete(terminal.name);
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
      return vscode.window.createTerminal(name);
    }
    return vscode.window.activeTerminal ?? vscode.window.createTerminal('Terminal');
  }

  async executeCommand(
    command: string,
    terminalName?: string,
    timeoutMs = 30000
  ): Promise<CommandResult> {
    const terminal = this.getOrCreateTerminal(terminalName);
    terminal.show(true);

    if (!terminal.shellIntegration) {
      await this.waitForShellIntegration(terminal, 8000);
    }

    if (!terminal.shellIntegration) {
      terminal.sendText(command);
      return {
        output:
          '[Shell integration unavailable — command sent but output not capturable.\n' +
          'Enable: settings > terminal.integrated.shellIntegration.enabled = true]',
        exitCode: undefined,
        timedOut: false,
      };
    }

    const execution = terminal.shellIntegration.executeCommand(command);
    this.ownExecutions.add(execution);

    let output = '';
    let timedOut = false;
    let exitCode: number | undefined;

    const exitCodePromise = new Promise<number | undefined>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === execution) {
          sub.dispose();
          resolve(e.exitCode);
        }
      });
    });

    const buf = this.getBuffer(terminal);
    const readPromise = (async () => {
      for await (const chunk of execution.read()) {
        output += chunk;
        buf.append(chunk); // also populate the buffer for readOutput
        if (timedOut) break;
      }
    })();

    const timeoutPromise = new Promise<void>((resolve) =>
      setTimeout(() => { timedOut = true; resolve(); }, timeoutMs)
    );

    await Promise.race([readPromise, timeoutPromise]);

    this.ownExecutions.delete(execution);

    if (!timedOut) {
      exitCode = await Promise.race([
        exitCodePromise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
      ]);
    }

    return {
      output: cleanShellOutput(output) || '(no output)',
      exitCode,
      timedOut,
    };
  }

  sendText(text: string, terminalName?: string, addNewline = true): void {
    const terminal = this.getOrCreateTerminal(terminalName);
    terminal.show(true);
    terminal.sendText(text, addNewline);
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
