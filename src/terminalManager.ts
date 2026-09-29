import * as vscode from 'vscode';
import { EventBus } from './events';

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

/** Cap on one execution's retained output. Beyond this the oldest text is discarded. */
const MAX_EXECUTION_OUTPUT = 4 * 1024 * 1024;
const TRUNCATION_MARKER = '[pylon: earlier output was truncated]\n';

const RECENT_RESULT_TTL_MS = 60_000;
const END_EVENT_WAIT_MS = 2000;

/**
 * CSI sequences: colors, cursor movement, clear-line, private-mode toggles, etc. Follows the
 * real ECMA-48 CSI grammar (optional `?` private-mode prefix, any final byte in 0x40-0x7E)
 * instead of a hand-picked final-byte list — a narrower list kept missing sequences like
 * cursor-hide/show (`\x1b[?25l`/`h`) and bracketed-paste toggles (`\x1b[?2004h`/`l`), which
 * shells, progress bars and many CLI tools emit routinely.
 */
const CSI_SEQUENCE_SRC = String.raw`\x1b\[[?]?[0-9;]*[@-~]`;
/**
 * OSC sequences (e.g. a window-title change), terminated by BEL (\x07) or ST (ESC \) — a
 * BEL-only pattern left any ST-terminated OSC sequence, which some shells and multiplexers emit
 * instead of BEL, unstripped in the output.
 */
const OSC_SEQUENCE_SRC = String.raw`\x1b\][\s\S]*?(?:\x07|\x1b\\)`;
/** Charset-designation sequences, e.g. \x1b(B. */
const CHARSET_SEQUENCE_SRC = String.raw`\x1b[()][AB012]`;
/** Any one control sequence, as a single alternation shared by every matcher below. */
const CONTROL_SEQUENCE_SRC = `${CSI_SEQUENCE_SRC}|${OSC_SEQUENCE_SRC}|${CHARSET_SEQUENCE_SRC}`;

/** Matches every control sequence (and a bare \r) in a string. */
// eslint-disable-next-line no-control-regex
const STRIP_ALL_SEQUENCES = new RegExp(`${CONTROL_SEQUENCE_SRC}|\\r`, 'g');

class OutputBuffer {
  private lines: string[] = [];
  private maxLines: number;
  private partial = '';
  // Stripping each incoming chunk on its own misses a sequence split across two append() calls
  // (e.g. "\x1b[3" here, "2mBUILD OK" next time) — reassembled only after each half had already
  // been stripped separately. Routing through the same stateful stripper the streaming path
  // uses holds the partial sequence back until it completes, same as createAnsiStripper's doc.
  private stripChunk = createAnsiStripper();

  constructor(maxLines: number) {
    this.maxLines = maxLines;
  }

  append(data: string): void {
    const cleaned = this.stripChunk(data);
    const all = this.partial + cleaned;
    // Guard against runaway partial (e.g. binary output with no newlines). Dropping it
    // silently made output vanish with no trace; a marker at least tells the reader why.
    if (all.length > 512 * 1024) {
      this.partial = '';
      this.lines.push('[pylon: dropped an over-long line with no newline]');
      if (this.lines.length > this.maxLines) this.lines.shift();
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
    const tail = this.stripChunk.flush();
    if (tail) this.partial += tail;
    if (this.partial) {
      this.lines.push(this.partial);
      this.partial = '';
    }
  }

  getLines(count?: number): string[] {
    if (count === undefined) return [...this.lines];
    if (count <= 0) return [];
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
  // Keyed by Terminal object identity, not by name: two terminals can share a name (or one can
  // be renamed after the fact), and a string key would then have them silently share — or
  // orphan — each other's buffer and busy-slot state.
  private outputBuffers = new Map<vscode.Terminal, OutputBuffer>();
  private disposables: vscode.Disposable[] = [];
  /** Set by AgentServer so terminal lifecycle can reach subscribers. */
  events: EventBus | null = null;
  private maxBufferLines: number;
  // Track executions we started so the passive listener skips them (we buffer directly)
  private ownExecutions = new Set<vscode.TerminalShellExecution>();
  private activeExecutions = new Map<vscode.Terminal, ExecutionState>();
  private recentResults = new Map<vscode.Terminal, RecentResult>();
  // Reserves a terminal between the busy-check and real registration (which can be up to 8s
  // away, across the shell-integration await) so two concurrent calls targeting the same
  // (possibly freshly created) terminal can't both see "nothing active" and both proceed.
  private pendingStarts = new Map<vscode.Terminal, { commandLine: string; startedAt: number }>();
  // Set by dispose(): tells every in-flight read loop (passive listener, executeCommand,
  // startBackgroundExecution) to stop touching manager state — dispose() itself has no way to
  // reach into those loops' local closures otherwise.
  private disposed = false;

  constructor(maxBufferLines: number) {
    this.maxBufferLines = maxBufferLines;
    this.setupListeners();
  }

  private getBuffer(terminal: vscode.Terminal): OutputBuffer {
    if (!this.outputBuffers.has(terminal)) {
      this.outputBuffers.set(terminal, new OutputBuffer(this.maxBufferLines));
    }
    return this.outputBuffers.get(terminal)!;
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
    this.activeExecutions.set(e.terminal, state);
    return state;
  }

  /**
   * Append a chunk to an execution's retained output, trimming from the front once it exceeds
   * MAX_EXECUTION_OUTPUT. Shared by all three sites that accumulate state.output — the passive
   * listener, the foreground read loop and the background drain — so only one of them enforcing
   * the cap no longer means the other two grow this string without bound.
   */
  private appendExecutionOutput(state: ExecutionState, chunk: string): void {
    state.output += chunk;
    if (state.output.length > MAX_EXECUTION_OUTPUT) {
      const overflow = state.output.length - MAX_EXECUTION_OUTPUT;
      state.output = state.output.slice(overflow);
      state.deliveredLength = Math.max(0, state.deliveredLength - overflow);
      // Mirror OutputBuffer's drop marker: trimming the front silently made a truncation
      // look identical to a process that simply produced less output than it actually did.
      if (!state.output.startsWith(TRUNCATION_MARKER)) {
        state.output = TRUNCATION_MARKER + state.output;
        // The prepend shifts state.output forward by the marker's length with no
        // corresponding shift in deliveredLength — only on this branch, since it's only
        // here that content is actually inserted ahead of what deliveredLength counts from.
        state.deliveredLength += TRUNCATION_MARKER.length;
      }
    }
  }

  private setupListeners(): void {
    // Passively buffer output from user-typed commands when shell integration is active.
    // onDidWriteTerminalData is a proposed API (blocked for packaged extensions), so we
    // rely on shell integration events for buffering instead.
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((e) => {
        this.events?.emit('terminal.started', {
          terminal: e.terminal.name,
          command: e.execution.commandLine?.value,
        });
        if (this.ownExecutions.has(e.execution)) {
          return; // executeCommand handles buffering + registration for its own executions
        }
        const commandLine = e.execution.commandLine?.value ?? '<user-typed command>';
        const state = this.registerExecution(e, commandLine);
        const buf = this.getBuffer(e.terminal);
        // The for-await body used to run directly inside this async listener with nothing
        // watching its promise — a read-loop rejection (e.g. the terminal closing mid-read)
        // became an unhandled rejection instead of just ending the loop.
        (async () => {
          for await (const chunk of e.execution.read()) {
            if (this.disposed) break;
            buf.append(chunk);
            this.appendExecutionOutput(state, chunk);
          }
        })().catch(() => {});
      })
    );

    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution((e) => {
        const state = this.activeExecutions.get(e.terminal);
        if (!state || state.execution !== e.execution) return;
        this.activeExecutions.delete(e.terminal);
        state.resolveEnd(e.exitCode);
        const finishedAt = Date.now();
        state.finishedAt = finishedAt;
        // The moment a subscriber to this terminal's buffer resource cares about: the buffer
        // now holds the complete output of a command that just finished.
        this.events?.emit('terminal.ended', { terminal: e.terminal.name, exitCode: e.exitCode });
        const undeliveredOutput = state.output.slice(state.deliveredLength);
        this.recentResults.set(e.terminal, {
          undeliveredOutput,
          exitCode: e.exitCode,
          finishedAt,
        });
        setTimeout(() => {
          // Only expire if this exact entry is still the current cached result.
          // If a newer execution finished and replaced the entry in the meantime,
          // its own TTL timer will handle expiry.
          const current = this.recentResults.get(e.terminal);
          if (current && current.finishedAt === finishedAt) {
            this.recentResults.delete(e.terminal);
          }
        }, RECENT_RESULT_TTL_MS);
      })
    );

    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        this.events?.emit('terminal.closed', { terminal: terminal.name });
        this.outputBuffers.get(terminal)?.flush();
        this.outputBuffers.delete(terminal);
        const state = this.activeExecutions.get(terminal);
        if (state) {
          this.activeExecutions.delete(terminal);
          state.resolveEnd(undefined);
          // The terminal closed mid-execution, so onDidEndTerminalShellExecution never fires
          // for it — emit the matching end event here too, or a subscriber pairing started/
          // ended per terminal would see this execution as still running forever.
          this.events?.emit('terminal.ended', { terminal: terminal.name, exitCode: undefined });
        }
        this.recentResults.delete(terminal);
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

  private busyError(
    terminalName: string,
    state: { commandLine: string; startedAt: number; output: string }
  ): Error {
    const elapsedSec = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
    const cleaned = cleanShellOutput(state.output);
    const lines = cleaned ? cleaned.split('\n').filter((l) => l.length > 0) : [];
    const tailCount = 3;
    const tail = lines.slice(-tailCount);
    const tailSection =
      tail.length > 0
        ? `last output:\n  ${tail.join('\n  ')}`
        : 'no output yet';
    return new Error(
      `Terminal '${terminalName}' is busy running: ${state.commandLine} ` +
      `(started ${elapsedSec}s ago, ${tailSection}). ` +
      `Use terminal_wait to continue waiting, terminal_send_text to provide input ` +
      `(send '\\x03' to abort), or target a different terminal.`
    );
  }

  // Reserves a terminal between the busy-check and real registration, which can be up to
  // 8s away across the shell-integration await below — without this, two concurrent calls
  // targeting the same (possibly freshly created) terminal could both see "nothing active"
  // and both proceed.
  private claimSlot(terminal: vscode.Terminal, command: string): void {
    const existing = this.activeExecutions.get(terminal);
    if (existing) {
      throw this.busyError(terminal.name, existing);
    }
    const pending = this.pendingStarts.get(terminal);
    if (pending) {
      throw this.busyError(terminal.name, { ...pending, output: '' });
    }
    this.pendingStarts.set(terminal, { commandLine: command, startedAt: Date.now() });
  }

  private releaseSlot(terminal: vscode.Terminal): void {
    this.pendingStarts.delete(terminal);
  }

  async executeCommand(
    command: string,
    terminalName?: string,
    timeoutMs = 300_000,
    onChunk?: (chunk: string) => void
  ): Promise<CommandResult> {
    const terminal = this.getOrCreateTerminal(terminalName);

    this.claimSlot(terminal, command);

    try {
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

      // One stripper per execution: it carries a partial escape sequence across chunk boundaries.
      const stripChunk = createAnsiStripper();
      // Once executeCommand has returned via the timeout branch below, the caller has already
      // been handed a timed-out response — further onChunk calls would just spend cycles
      // stripping ANSI for a listener that is gone. state.output/buf keep accumulating either
      // way, so a later terminal_wait still sees everything once the command actually finishes.
      let streamEnded = false;
      const readPromise = (async () => {
        for await (const chunk of execution.read()) {
          if (this.disposed) break;
          // Bounded: the 2000-line cap applies to OutputBuffer only, so a long verbose process
          // used to accumulate its entire output here as one ever-growing string. Keep the tail,
          // which is what an incremental terminal_wait and the final result actually read.
          this.appendExecutionOutput(state, chunk);
          buf.append(chunk);
          // Strip control sequences before streaming. The final result goes through
          // cleanShellOutput, so leaving the chunks raw meant a client that concatenated the
          // progress messages got materially different text from the result it was handed.
          if (onChunk && !streamEnded) {
            const cleaned = stripChunk(chunk);
            if (cleaned) onChunk(cleaned);
          }
        }
        // A trailing partial escape sequence held back across the last chunk boundary would
        // otherwise be silently dropped now that the source has no more chunks coming.
        if (onChunk && !streamEnded) {
          const tail = stripChunk.flush();
          if (tail) onChunk(tail);
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
        let endTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const exitCode = await Promise.race([
          state.endPromise,
          new Promise<undefined>((resolve) => {
            endTimeoutHandle = setTimeout(() => resolve(undefined), END_EVENT_WAIT_MS);
          }),
        ]);
        if (endTimeoutHandle) clearTimeout(endTimeoutHandle);
        const slice = state.output.slice(state.deliveredLength);
        state.deliveredLength = state.output.length;
        // The generic end-listener wrote recentResults for this execution with the
        // full output (since deliveredLength was 0 at the moment of the end event).
        // We just delivered the content, so update the cache entry to empty undelivered
        // content — don't delete it; a subsequent terminal_wait within the TTL should
        // still find the entry and report "(no new output)" + exit code + age marker.
        const recent = this.recentResults.get(terminal);
        if (recent && state.finishedAt !== undefined && recent.finishedAt === state.finishedAt) {
          this.recentResults.set(terminal, {
            undeliveredOutput: '',
            exitCode: recent.exitCode,
            finishedAt: recent.finishedAt,
          });
        }
        const outputText = cleanShellOutput(slice) || '(no output)';
        return {
          output:
            exitCode === undefined
              ? `${outputText}\n\n[Exit code not yet reported by the shell — call terminal_wait ` +
                `(terminal_name='${terminal.name}') to retrieve it once VS Code delivers the end event.]`
              : outputText,
          exitCode,
          timedOut: false,
        };
      }

      // Timeout: command keeps running, terminal stays busy. The response below is final for
      // this call, so stop the still-running read loop from calling onChunk any further.
      streamEnded = true;
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
    } finally {
      this.releaseSlot(terminal);
    }
  }

  async startBackgroundExecution(
    command: string,
    terminalName?: string
  ): Promise<{ terminalName: string; message: string }> {
    const terminal = this.getOrCreateTerminal(terminalName);

    this.claimSlot(terminal, command);

    try {
      terminal.show(true);

      if (!terminal.shellIntegration) {
        await this.waitForShellIntegration(terminal, 8000);
      }

      if (!terminal.shellIntegration) {
        terminal.sendText(command);
        return {
          terminalName: terminal.name,
          message:
            `[Shell integration unavailable — command sent via sendText to '${terminal.name}'. ` +
            `terminal_wait and exit codes won't work for this terminal.\n` +
            `Enable: terminal.integrated.shellIntegration.enabled = true]`,
        };
      }

      const execution = terminal.shellIntegration.executeCommand(command);
      this.ownExecutions.add(execution);
      const state = this.registerExecution({ terminal, execution }, command);
      const buf = this.getBuffer(terminal);

      // Drain the read iterator in the background into state.output + buf.
      // Attach a no-op rejection handler so a mid-iteration error doesn't surface
      // as UnhandledPromiseRejection. The generic end-listener still handles cleanup.
      (async () => {
        try {
          for await (const chunk of execution.read()) {
            if (this.disposed) break;
            this.appendExecutionOutput(state, chunk);
            buf.append(chunk);
          }
        } finally {
          this.ownExecutions.delete(execution);
        }
      })().catch(() => {});

      return {
        terminalName: terminal.name,
        message:
          `Command started in terminal '${terminal.name}': ${command}\n` +
          `Use terminal_wait (terminal_name='${terminal.name}') to retrieve output and exit code.`,
      };
    } finally {
      this.releaseSlot(terminal);
    }
  }

  async waitForExecution(
    terminalName: string,
    timeoutMs = 300_000
  ): Promise<CommandResult & { fromCache?: boolean; cacheAgeMs?: number }> {
    // Resolved once, by the current name, to the live Terminal object the Maps are actually
    // keyed on — so a terminal renamed after its command started is still found (its object
    // identity didn't change), where a name-keyed lookup would have missed it entirely.
    const terminal = vscode.window.terminals.find((t) => t.name === terminalName);
    const state = terminal && this.activeExecutions.get(terminal);

    if (terminal && !state && this.pendingStarts.has(terminal)) {
      // claimSlot reserves the terminal here before shell integration is awaited (up to ~8s)
      // and before the execution is registered in activeExecutions. Without this, a
      // terminal_wait issued in that window fell through both the activeExecutions and
      // recentResults checks below and hit the final "no active or recent execution" error —
      // false, since a command genuinely was just started. Poll briefly for promotion instead.
      const pollDeadline = Date.now() + 8000;
      while (
        this.pendingStarts.has(terminal) &&
        !this.activeExecutions.has(terminal) &&
        Date.now() < pollDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (this.activeExecutions.has(terminal)) {
        return this.waitForExecution(terminalName, timeoutMs);
      }
      if (this.pendingStarts.has(terminal)) {
        return {
          output: '(command is still starting — shell integration has not attached yet; call terminal_wait again shortly)',
          exitCode: undefined,
          timedOut: true,
        };
      }
      // pendingStarts was released (claimSlot's finally ran) without ever registering in
      // activeExecutions — fall through to the recentResults/final-error checks below.
    }

    if (terminal && state) {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const endPromise = state.endPromise.then((exitCode) => ({ kind: 'done' as const, exitCode }));
      const outcome = await Promise.race([endPromise, timeoutPromise]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const slice = state.output.slice(state.deliveredLength);
      state.deliveredLength = state.output.length;

      if (outcome === 'timeout') {
        const body = cleanShellOutput(slice) || '(no new output)';
        return {
          output:
            `${body}\n\n[STILL RUNNING — ${Math.round(timeoutMs / 1000)}s waited, no exit yet. ` +
            `Call terminal_wait again or send '\\x03' via terminal_send_text to abort.]`,
          exitCode: undefined,
          timedOut: true,
        };
      }

      // We delivered the content; replace the cache entry with empty undelivered
      // rather than deleting. A subsequent terminal_wait within the TTL will still
      // find the entry and report "(no new output)" + exit code + age marker.
      const recent = this.recentResults.get(terminal);
      if (recent && state.finishedAt !== undefined && recent.finishedAt === state.finishedAt) {
        this.recentResults.set(terminal, {
          undeliveredOutput: '',
          exitCode: recent.exitCode,
          finishedAt: recent.finishedAt,
        });
      }

      return {
        output: cleanShellOutput(slice) || '(no output)',
        exitCode: outcome.exitCode,
        timedOut: false,
      };
    }

    // No active execution — check the recent-result cache.
    const cached = terminal && this.recentResults.get(terminal);
    if (terminal && cached && Date.now() - cached.finishedAt < RECENT_RESULT_TTL_MS) {
      this.recentResults.delete(terminal);
      const ageMs = Date.now() - cached.finishedAt;
      const body = cleanShellOutput(cached.undeliveredOutput) || '(no output)';
      return {
        output: `${body}\n\n[completed ${Math.round(ageMs / 1000)}s ago]`,
        exitCode: cached.exitCode,
        timedOut: false,
        fromCache: true,
        cacheAgeMs: ageMs,
      };
    }

    throw new Error(
      `Terminal '${terminalName}' has no active or recent execution. ` +
      `Start one with terminal_run, or check terminal_list.`
    );
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

    const buf = this.outputBuffers.get(terminal);
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

    this.outputBuffers.get(terminal)?.clear();
  }

  private waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (terminal.shellIntegration) { resolve(); return; }

      // Both exits must dispose the listener. The timeout path used to resolve without it,
      // and the subscription is not in this.disposables either — so every shell-integration
      // timeout leaked one global listener for the life of the extension host.
      let sub: vscode.Disposable | undefined;
      const settle = (): void => {
        clearTimeout(timer);
        sub?.dispose();
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) settle();
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.disposables.forEach((d) => d.dispose());
    // Resolve rather than drop: anyone still awaiting endPromise (executeCommand's read-loop
    // race, a concurrent waitForExecution) would otherwise hang forever past extension shutdown.
    for (const state of this.activeExecutions.values()) {
      state.resolveEnd(undefined);
    }
    this.outputBuffers.clear();
    this.activeExecutions.clear();
    this.recentResults.clear();
    this.pendingStarts.clear();
  }
}

/**
 * Strip terminal control sequences without touching surrounding whitespace.
 *
 * Split out from cleanShellOutput so streamed chunks can be cleaned too: a chunk is a fragment
 * of a line, so trimming it would eat the indentation and line breaks that make the stream
 * readable when the client concatenates it.
 */
export function stripAnsi(raw: string): string {
  return raw.replace(STRIP_ALL_SEQUENCES, '');
}

function cleanShellOutput(raw: string): string {
  return stripAnsi(raw).trim();
}

/** Longest escape sequence worth holding back while waiting for the rest of it. */
const MAX_PENDING_ESCAPE = 512;

/** Matches a *complete* escape sequence at the start of a string. */
const COMPLETE_ESCAPE = new RegExp(`^(?:${CONTROL_SEQUENCE_SRC})`);

/** A stateful stripper for streamed output, plus a way to flush what it's holding back. */
export interface AnsiStripper {
  (chunk: string): string;
  /**
   * Flush any partial escape sequence still held back. Call once the source has no more chunks
   * coming — otherwise a stream that ends mid-sequence, or with a lone ESC byte that never went
   * on to start one, silently loses those trailing bytes.
   */
  flush(): string;
}

/**
 * A stateful stripper for streamed output.
 *
 * Stripping each chunk on its own does not work: `read()` happily splits `\x1b[32m` into
 * `"\x1b[3"` and `"2mBUILD OK"`, and neither half matches the pattern, so the escape survives
 * into the stream verbatim. This holds back a trailing partial sequence until the next chunk
 * completes it — the same trick OutputBuffer already uses for partial lines.
 */
export function createAnsiStripper(): AnsiStripper {
  let pending = '';
  const strip = ((chunk: string): string => {
    const all = pending + chunk;
    // Only the tail can still be an in-progress sequence — a \x1b further back than the longest
    // sequence this recognizes is already complete (or not a sequence at all) — so bound the
    // scan instead of re-scanning however much of `all` has piled up.
    const searchStart = Math.max(0, all.length - MAX_PENDING_ESCAPE);
    const escInTail = all.slice(searchStart).lastIndexOf('\x1b');
    const esc = escInTail === -1 ? -1 : searchStart + escInTail;
    // Hold back from the last ESC only when it could still grow into a sequence: not already
    // complete. (Bounded by construction: esc only ever comes from the last MAX_PENDING_ESCAPE
    // characters of `all`, so `all.length - esc <= MAX_PENDING_ESCAPE` always holds already.)
    if (esc !== -1 && !COMPLETE_ESCAPE.test(all.slice(esc))) {
      pending = all.slice(esc);
      return stripAnsi(all.slice(0, esc));
    }
    pending = '';
    return stripAnsi(all);
  }) as AnsiStripper;
  strip.flush = (): string => {
    const held = pending;
    pending = '';
    return stripAnsi(held);
  };
  return strip;
}
