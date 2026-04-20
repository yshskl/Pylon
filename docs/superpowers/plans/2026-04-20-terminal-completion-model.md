# Terminal completion model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Pylon's 3-second output-idle heuristic with the authoritative `onDidEndTerminalShellExecution` signal, add busy-terminal tracking, add a `terminal_wait` tool, and stream output via MCP progress notifications.

**Architecture:** `TerminalManager` grows two state maps (`activeExecutions`, `recentResults`) keyed by terminal name. `executeCommand` becomes a two-way race (read-done vs timeout) with no idle branch. A new `terminal_wait` tool consumes incremental output slices via a `deliveredLength` cursor per execution. A progress-token callback plumbs through from `hubServer` → `agentServer` → `TerminalManager` and emits `notifications/progress` JSON-RPC messages during the open MCP call.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.window.onDidStartTerminalShellExecution`, `onDidEndTerminalShellExecution`, `TerminalShellExecution.read()`), Node `http`.

**Testing convention:** Project has no test framework (zero-dependency policy per CLAUDE.md). Verification is `npm run compile` (type-check) plus manual reproduction cases from the spec, run in WSL/VS Code with Pylon installed from a local `.vsix`.

**Spec:** [docs/superpowers/specs/2026-04-20-terminal-completion-model-design.md](../specs/2026-04-20-terminal-completion-model-design.md)

---

## File map

| File | Change |
|---|---|
| `src/terminalManager.ts` | Heavy: rewrite `executeCommand`, add `ExecutionState` + `RecentResult` types, add `activeExecutions` + `recentResults` maps, add `startBackgroundExecution` (wait=false path), add `waitForExecution` (powers `terminal_wait`), extend listeners to track user-typed commands |
| `src/hubServer.ts` | Add `HUB_TOOLS` entry for `terminal_wait`, rewrite `terminal_run` / `terminal_send_text` descriptions, add `progressToken` extraction from `_meta` and plumbing |
| `src/agentServer.ts` | Add `case 'terminal_wait':` handler, accept `progressToken` + progress callback forwarding in `callTool`, update `terminal_run` case to pass the callback and handle wait=false |

---

## Task 1: Add ExecutionState / RecentResult types and state maps (no behavior change)

**Files:**
- Modify: `src/terminalManager.ts` (top-level interfaces, class fields, no logic change yet)

Goal: introduce infrastructure that future tasks will fill in. After this task, the file compiles and existing behavior is unchanged.

- [ ] **Step 1: Add new interfaces alongside existing ones**

At the top of `src/terminalManager.ts`, after the existing `CommandResult` interface (around line 14), add:

```typescript
interface ExecutionState {
  execution: vscode.TerminalShellExecution;
  terminalName: string;
  commandLine: string;
  startedAt: number;
  output: string;
  deliveredLength: number;
  endPromise: Promise<number | undefined>;
  resolveEnd: (exitCode: number | undefined) => void;
}

interface RecentResult {
  undeliveredOutput: string;
  exitCode: number | undefined;
  finishedAt: number;
}

const RECENT_RESULT_TTL_MS = 60_000;
```

- [ ] **Step 2: Add the state maps as class fields**

In the `TerminalManager` class, next to the existing `outputBuffers` and `ownExecutions` fields (around line 70-74), add:

```typescript
  private activeExecutions = new Map<string, ExecutionState>();
  private recentResults = new Map<string, RecentResult>();
```

- [ ] **Step 3: Compile and verify no regressions**

Run: `npm run compile`
Expected: clean compile, no TS errors.

- [ ] **Step 4: Commit**

```bash
git add src/terminalManager.ts
git commit -m "refactor: add ExecutionState/RecentResult types and state maps"
```

---

## Task 2: Track user-typed commands in activeExecutions

**Files:**
- Modify: `src/terminalManager.ts` (the `setupListeners` method and one helper)

Goal: the existing `onDidStartTerminalShellExecution` listener already fires for user-typed commands; extend it to populate `activeExecutions` so future busy-checks see them. The passive buffering behavior is preserved.

- [ ] **Step 1: Add a helper to register an execution**

Add this private method on `TerminalManager`, right after `getBuffer` (around line 88):

```typescript
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
```

- [ ] **Step 2: Update the passive start-listener**

Replace the existing `onDidStartTerminalShellExecution` subscription (around lines 94-103) with:

```typescript
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
```

- [ ] **Step 3: Add the matching end-listener**

Immediately after the start-listener subscription, add a new subscription:

```typescript
    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution((e) => {
        const state = this.activeExecutions.get(e.terminal.name);
        if (!state || state.execution !== e.execution) return;
        this.activeExecutions.delete(e.terminal.name);
        state.resolveEnd(e.exitCode);
        const finishedAt = Date.now();
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
```

- [ ] **Step 4: Update `onDidCloseTerminal` listener to clean up state**

Replace the existing `onDidCloseTerminal` subscription (around lines 105-111) with:

```typescript
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
```

- [ ] **Step 5: Compile and verify**

Run: `npm run compile`
Expected: clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/terminalManager.ts
git commit -m "feat: track user-typed commands in activeExecutions"
```

---

## Task 3: Rewrite executeCommand (blocking wait=true path)

**Files:**
- Modify: `src/terminalManager.ts` — replace the body of `executeCommand` (lines 182-280)

Goal: remove the idle heuristic, use `onDidEndTerminalShellExecution` as the authoritative completion signal, add busy-check, return incremental output slices, integrate with `activeExecutions` / `recentResults`.

- [ ] **Step 1: Add a helper for the busy-check error**

Above `executeCommand` (around line 180), add:

```typescript
  private busyError(terminalName: string, state: ExecutionState): Error {
    return new Error(
      `Terminal '${terminalName}' is busy running: ${state.commandLine}. ` +
      `Use terminal_wait to wait for completion, terminal_send_text to provide input ` +
      `(send '\\x03' to abort), or target a different terminal.`
    );
  }
```

- [ ] **Step 2: Replace executeCommand body**

Replace the entire `executeCommand` method (lines 182-280) with:

```typescript
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

    const endSub = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.execution !== execution) return;
      endSub.dispose();
      // The generic end-listener from setupListeners will fire too and handle
      // activeExecutions cleanup + recentResults insertion. We just need to
      // resolve the local exit code promise here if it hasn't resolved yet.
      // (It will have: the generic listener also calls resolveEnd.)
    });

    const buf = this.getBuffer(terminal);

    const readPromise = (async () => {
      for await (const chunk of execution.read()) {
        state.output += chunk;
        buf.append(chunk);
        if (onChunk) onChunk(chunk);
      }
    })();

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
      // execution.read() completed. exit code should be resolved via the generic
      // end-listener; wait briefly in case of microtask ordering.
      const exitCode = await Promise.race([
        state.endPromise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
      ]);
      const slice = state.output.slice(state.deliveredLength);
      state.deliveredLength = state.output.length;
      // Clean up recentResults the generic listener wrote — this caller already
      // received the content.
      const recent = this.recentResults.get(terminal.name);
      if (recent && recent.finishedAt >= state.startedAt) {
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
```

- [ ] **Step 3: Compile**

Run: `npm run compile`
Expected: clean compile.

- [ ] **Step 4: Package and install locally for manual verification**

Run (in WSL):
```bash
vsce package
code --install-extension pylon-0.4.0.vsix --force
```
Then reload VS Code.

- [ ] **Step 5: Manual reproduction — the silent-pause case**

In a Claude session against this workspace, call (via the MCP tool):
```
terminal_run(command="echo start; sleep 5; echo middle; sleep 5; echo end",
             terminal_name="verify-task3", session_id="vscode-claude-terminal")
```
Expected result: returns after ~10s total with all three lines (`start`, `middle`, `end`) and `[exit code: 0]`. No `[Output idle for 3s...]` marker.

- [ ] **Step 6: Manual reproduction — busy-terminal refusal**

Start a long-running command:
```
terminal_run(command="sleep 20", terminal_name="verify-task3-busy", timeout_ms=3000, ...)
```
Expected: returns at 3s with `[STILL RUNNING ...]`. Then immediately:
```
terminal_run(command="echo should-refuse", terminal_name="verify-task3-busy", ...)
```
Expected: error matching `Terminal 'verify-task3-busy' is busy running: sleep 20. ...`

- [ ] **Step 7: Commit**

```bash
git add src/terminalManager.ts
git commit -m "feat: rewrite executeCommand to use onDidEndTerminalShellExecution as source of truth"
```

---

## Task 4: Implement the wait=false path

**Files:**
- Modify: `src/terminalManager.ts` — add a new `startBackgroundExecution` method

Goal: let the agentServer start a command without blocking. The command's output accumulates into `ExecutionState.output` so subsequent `terminal_wait` calls can retrieve it.

- [ ] **Step 1: Add startBackgroundExecution method**

Immediately after `executeCommand` in `src/terminalManager.ts`, add:

```typescript
  async startBackgroundExecution(
    command: string,
    terminalName?: string
  ): Promise<{ terminalName: string; message: string }> {
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
        terminalName: terminal.name,
        message:
          `Shell integration unavailable. Command sent via sendText to '${terminal.name}'; ` +
          `terminal_wait won't return an exit code for this terminal.`,
      };
    }

    const execution = terminal.shellIntegration.executeCommand(command);
    this.ownExecutions.add(execution);
    const state = this.registerExecution({ terminal, execution }, command);
    const buf = this.getBuffer(terminal);

    // Drain the read iterator in the background into state.output + buf.
    (async () => {
      try {
        for await (const chunk of execution.read()) {
          state.output += chunk;
          buf.append(chunk);
        }
      } finally {
        this.ownExecutions.delete(execution);
      }
    })();

    return {
      terminalName: terminal.name,
      message:
        `Command started in terminal '${terminal.name}': ${command}\n` +
        `Use terminal_wait (terminal_name='${terminal.name}') to retrieve output and exit code.`,
    };
  }
```

- [ ] **Step 2: Compile**

Run: `npm run compile`
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/terminalManager.ts
git commit -m "feat: add startBackgroundExecution for wait=false runs"
```

---

## Task 5: Implement terminal_wait in TerminalManager

**Files:**
- Modify: `src/terminalManager.ts` — add `waitForExecution` method

Goal: the engine for the new tool. Returns incremental output + exit code, or the cached result if the execution already finished.

- [ ] **Step 1: Add waitForExecution method**

Immediately after `startBackgroundExecution`, add:

```typescript
  async waitForExecution(
    terminalName: string,
    timeoutMs = 300_000
  ): Promise<CommandResult & { fromCache?: boolean; cacheAgeMs?: number }> {
    const state = this.activeExecutions.get(terminalName);
    if (state) {
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

      // Completed. The generic end-listener already wrote recentResults; clear it
      // since we delivered the content here.
      const recent = this.recentResults.get(terminalName);
      if (recent && recent.finishedAt >= state.startedAt) {
        this.recentResults.delete(terminalName);
      }

      return {
        output: cleanShellOutput(slice) || '(no output)',
        exitCode: outcome.exitCode,
        timedOut: false,
      };
    }

    // No active execution — check the recent-result cache.
    const cached = this.recentResults.get(terminalName);
    if (cached && Date.now() - cached.finishedAt < RECENT_RESULT_TTL_MS) {
      this.recentResults.delete(terminalName);
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
```

- [ ] **Step 2: Compile**

Run: `npm run compile`
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/terminalManager.ts
git commit -m "feat: add waitForExecution powering terminal_wait"
```

---

## Task 6: Expose terminal_wait via HUB_TOOLS and AgentServer

**Files:**
- Modify: `src/hubServer.ts` — add `HUB_TOOLS` entry
- Modify: `src/agentServer.ts` — add `case 'terminal_wait':` + handle wait=false in `terminal_run` via `startBackgroundExecution`

Goal: tool is reachable end-to-end from the MCP client.

- [ ] **Step 1: Add HUB_TOOLS entry for terminal_wait**

In `src/hubServer.ts`, after the `terminal_clear_buffer` tool entry (around line 133), insert:

```typescript
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
```

- [ ] **Step 2: Update the terminal_run case in agentServer.ts**

In `src/agentServer.ts`, find the existing `case 'terminal_run':` block (around lines 169-184). Replace the entire block with:

```typescript
            case 'terminal_run': {
                const command = args.command as string;
                const terminalName = args.terminal_name as string | undefined;
                const wait = (args.wait as boolean | undefined) ?? true;
                if (!wait) {
                    const result = await this.terminalManager.startBackgroundExecution(command, terminalName);
                    return text(result.message);
                }
                const timeoutMs = (args.timeout_ms as number | undefined) ?? 300_000;
                const result = await this.terminalManager.executeCommand(command, terminalName, timeoutMs);
                let response = result.output || '(no output)';
                if (result.exitCode !== undefined) {
                    response += `\n[exit code: ${result.exitCode}]`;
                }
                return text(response);
            }
```

Note: the existing code's response-building pattern (appending `\n[exit code: N]` only when defined) is preserved. `text(...)` is the in-scope helper at the top of `callTool` that wraps a string into a `ToolResult`.

- [ ] **Step 3: Add the terminal_wait case in agentServer.ts**

Find the `case 'terminal_clear_buffer':` block in `src/agentServer.ts`, and immediately after its closing brace add:

```typescript
            case 'terminal_wait': {
                const terminalName = args.terminal_name as string;
                if (!terminalName) {
                    throw new Error("terminal_wait requires 'terminal_name'.");
                }
                const timeoutMs = (args.timeout_ms as number | undefined) ?? 300_000;
                const result = await this.terminalManager.waitForExecution(terminalName, timeoutMs);
                let response = result.output || '(no output)';
                if (result.exitCode !== undefined) {
                    response += `\n[exit code: ${result.exitCode}]`;
                }
                return text(response);
            }
```

- [ ] **Step 4: Update the terminal_run HUB_TOOLS description**

In `src/hubServer.ts`, replace the existing `terminal_run` description (around lines 60-67) with:

```typescript
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
      'Returns final output with \'[exit code: N]\' on success. ' + SESSION_ID_NOTE,
```

- [ ] **Step 5: Update the terminal_run timeout_ms param description**

In the same `terminal_run` tool entry in `src/hubServer.ts`, update the `timeout_ms` property description from:
```
'Hard timeout in milliseconds (default: 30000). Command returns early if output settles before this.'
```
to:
```
'Hard timeout in milliseconds (default: 300000 = 5 min). On timeout, the command keeps running — use terminal_wait to continue retrieving output.'
```

- [ ] **Step 6: Update the terminal_send_text description**

Replace the existing `terminal_send_text` description (around lines 85-88) with:

```typescript
    description:
      'Send text/input to a terminal WITHOUT capturing output. Works on busy terminals — this is ' +
      'how you answer prompts in a running command or abort it (send \'\\x03\' for Ctrl+C, ' +
      '\'\\x04\' for Ctrl+D). Use terminal_wait afterward to retrieve the result of the ' +
      'interrupted command. ' + SESSION_ID_NOTE,
```

- [ ] **Step 7: Compile**

Run: `npm run compile`
Expected: clean compile.

- [ ] **Step 8: Package, install, reload VS Code**

Run (in WSL):
```bash
vsce package
code --install-extension pylon-0.4.0.vsix --force
```
Reload VS Code.

- [ ] **Step 9: Manual reproduction — wait=false + terminal_wait round trip**

In a Claude session:
```
terminal_run(command="sleep 2 && echo done", terminal_name="verify-task6",
             wait=false, session_id="vscode-claude-terminal")
```
Expected: returns instantly with a message containing `Command started in terminal 'verify-task6'`. Then:
```
terminal_wait(terminal_name="verify-task6", timeout_ms=5000, session_id="...")
```
Expected: returns `done` + `[exit code: 0]` (latency ~2s from start of this call).

- [ ] **Step 10: Manual reproduction — cached result window**

Run a short command:
```
terminal_run(command="echo cached-me", terminal_name="verify-task6-cache", ...)
```
Wait ~5s. Then:
```
terminal_wait(terminal_name="verify-task6-cache", ...)
```
Expected: output `(no output)` or `cached-me` (see note below on behavior) + `[exit code: 0 — completed ~Xs ago]`.

Note: because `terminal_run` with `wait=true` already drained the output into itself (`deliveredLength === output.length` at completion), the cached `undeliveredOutput` is empty. `terminal_wait` on a cached-but-drained result returns `(no output)` + the exit code + `[completed Xs ago]`. That's expected — the cache is primarily for the `wait=false` flow where the delivery happens via `terminal_wait`.

- [ ] **Step 11: Commit**

```bash
git add src/hubServer.ts src/agentServer.ts
git commit -m "feat: expose terminal_wait tool and route wait=false to startBackgroundExecution"
```

---

## Task 7: MCP progress notification streaming

**Files:**
- Modify: `src/hubServer.ts` — extract `_meta.progressToken` from incoming tool calls, pass progress callback through
- Modify: `src/agentServer.ts` — accept progress callback in `callTool`, invoke on chunks; forward to satellites via a header
- Modify: `src/terminalManager.ts` — `executeCommand` already accepts `onChunk` (Task 3); no changes needed here

Goal: when the MCP client sends a `progressToken` in `_meta`, Pylon streams output chunks back as `notifications/progress` JSON-RPC messages on the same HTTP response.

Implementation note: Pylon's current handler at [hubServer.ts:593-600](../../../src/hubServer.ts#L593-L600) sends a single JSON response via `parseBody` + `res.end(JSON.stringify(response))`. For streaming, we split the POST /mcp branch into two paths: when `_meta.progressToken` is present on a `tools/call` request, we write notification objects as newline-delimited JSON during the call and append the final response line at the end. When absent, existing behavior is preserved byte-for-byte.

- [ ] **Step 1: Extend AgentServer.callTool signature**

In `src/agentServer.ts`, change the `callTool` signature at line 154 from:

```typescript
    async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
```
to:
```typescript
    async callTool(
        name: string,
        args: Record<string, unknown>,
        onProgress?: (chunk: string) => void,
    ): Promise<ToolResult> {
```

Then update the `case 'terminal_run':` block (the wait-branch only) so it passes `onProgress` to `executeCommand`. Replace this line (around line 178):

```typescript
                const result = await this.terminalManager.executeCommand(command, terminalName, timeoutMs);
```
with:
```typescript
                const result = await this.terminalManager.executeCommand(command, terminalName, timeoutMs, onProgress);
```

- [ ] **Step 2: Extend routeToolCall signature in hubServer**

In `src/hubServer.ts`, change the `routeToolCall` signature at line 675 from:

```typescript
  private async routeToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
```
to:
```typescript
  private async routeToolCall(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (chunk: string) => void,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
```

Inside `routeToolCall`, update the own-agent dispatch (around line 736) from:
```typescript
    return await this.ownAgent.callTool(name, args);
```
to:
```typescript
    return await this.ownAgent.callTool(name, args, onProgress);
```

The satellite-forward path (`forwardToAgent`) does NOT get `onProgress` — progress streaming across the hub→satellite HTTP hop is not plumbed in this change. Add a one-line comment right above the satellite dispatch:
```typescript
    // Progress notifications stream only when the tool runs on the hub. Satellite
    // calls still return the final result; just no mid-flight chunks.
```

- [ ] **Step 3: Extend handleMCPRequest signature**

In `src/hubServer.ts`, change the `handleMCPRequest` signature at line 634 from:

```typescript
  private async handleMCPRequest(req: MCPRequest): Promise<MCPResponse> {
```
to:
```typescript
  private async handleMCPRequest(
    req: MCPRequest,
    onProgress?: (chunk: string) => void,
  ): Promise<MCPResponse> {
```

Inside the `case 'tools/call':` block (around line 660), change:
```typescript
          const result = await this.routeToolCall(params.name, params.arguments ?? {});
```
to:
```typescript
          const result = await this.routeToolCall(params.name, params.arguments ?? {}, onProgress);
```

- [ ] **Step 4: Split the POST /mcp handler into streaming vs single-response paths**

In `src/hubServer.ts`, replace the existing POST /mcp branch (lines 593-600) with:

```typescript
      if (req.method === 'POST' && req.url === '/mcp') {
        this.parseBody(req, res, async (body) => {
          const request = body as MCPRequest;
          const progressToken =
            request.method === 'tools/call'
              ? (request.params as { _meta?: { progressToken?: string | number } } | undefined)?._meta?.progressToken
              : undefined;

          if (progressToken !== undefined) {
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            let progressBytes = 0;
            const onProgress = (chunk: string) => {
              progressBytes += chunk.length;
              res.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'notifications/progress',
                  params: { progressToken, progress: progressBytes, message: chunk },
                }) + '\n'
              );
            };
            const response = await this.handleMCPRequest(request, onProgress);
            res.write(JSON.stringify(response) + '\n');
            res.end();
          } else {
            const response = await this.handleMCPRequest(request);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          }
        });
        return;
      }
```

- [ ] **Step 5: Compile**

Run: `npm run compile`
Expected: clean compile.

- [ ] **Step 6: Package and install**

Run (in WSL):
```bash
vsce package
code --install-extension pylon-0.4.0.vsix --force
```
Reload VS Code.

- [ ] **Step 7: Manual reproduction — streaming path**

From a Claude Code session (which sends `progressToken` by default for long tool calls), call:
```
terminal_run(command="for i in 1 2 3 4 5; do echo line-$i; sleep 1; done",
             terminal_name="verify-task7", session_id="...")
```
Expected: in Claude Code's UI, you see the lines stream in roughly once per second as they're produced, rather than all appearing after 5s.

- [ ] **Step 8: Manual reproduction — non-streaming path (no regression)**

From a non-streaming MCP client (or by manually POST to `/mcp` without `_meta.progressToken`), call a simple `terminal_run`. Expected: single JSON response with full output, as today.

Quick curl check (from WSL):
```bash
curl -s -X POST http://127.0.0.1:27681/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"terminal_run","arguments":{"command":"echo ok","terminal_name":"verify-task7-curl","session_id":"vscode-claude-terminal"}}}'
```
Expected: a single-line JSON-RPC response ending with `"result":{"content":[{"type":"text","text":"ok\n[exit code: 0]"}]}}`.

- [ ] **Step 9: Commit**

```bash
git add src/hubServer.ts src/agentServer.ts
git commit -m "feat: stream terminal_run output via MCP progress notifications"
```

---

## Task 8: Full manual reproduction pass

**Files:** none modified unless bugs found.

Goal: exercise every reproduction case from the spec's Testing section. Any discrepancy becomes a fix in this task.

- [ ] **Step 1: Reproduction case 1 — silent-pause command**

```
terminal_run(command="echo start; sleep 5; echo middle; sleep 5; echo end",
             terminal_name="spec-case-1", session_id="...")
```
Expected: ~10s total, full output (`start`, `middle`, `end`), `[exit code: 0]`. No "idle" marker, no truncation.

- [ ] **Step 2: Reproduction case 2 — timeout + resume**

```
terminal_run(command="echo a; sleep 10; echo b", terminal_name="spec-case-2",
             timeout_ms=3000, session_id="...")
```
Expected: returns at ~3s with `a` and `[STILL RUNNING ...]`. Then:
```
terminal_wait(terminal_name="spec-case-2", timeout_ms=15000, session_id="...")
```
Expected: returns `b` + `[exit code: 0]`.

- [ ] **Step 3: Reproduction case 3 — busy-terminal refusal (Pylon-initiated)**

Start a long run:
```
terminal_run(command="sleep 30", terminal_name="spec-case-3",
             timeout_ms=2000, wait=true, session_id="...")
```
(Returns STILL RUNNING after 2s.) Immediately:
```
terminal_run(command="echo nope", terminal_name="spec-case-3", session_id="...")
```
Expected: error containing `Terminal 'spec-case-3' is busy running: sleep 30.`

Clean up: `terminal_send_text(text="\x03", terminal_name="spec-case-3", ...)`.

- [ ] **Step 4: Reproduction case 4 — wait=false full flow**

```
terminal_run(command="sleep 2 && echo done", terminal_name="spec-case-4",
             wait=false, session_id="...")
```
Expected: instant return with `Command started in terminal 'spec-case-4': ...`.
```
terminal_wait(terminal_name="spec-case-4", timeout_ms=5000, session_id="...")
```
Expected: `done` + `[exit code: 0]`.

- [ ] **Step 5: Reproduction case 5 — user-typed command counts as busy**

Manually type `sleep 30` in a terminal named (or renamed to) `spec-case-5` and hit Enter. Immediately:
```
terminal_run(command="echo should-refuse", terminal_name="spec-case-5", session_id="...")
```
Expected: error containing `Terminal 'spec-case-5' is busy running: sleep 30.` (The `commandLine` string may be wrapped or differ slightly depending on how shell integration reports it.)

- [ ] **Step 6: Reproduction case 6 — recent-result cache**

```
terminal_run(command="echo cached", terminal_name="spec-case-6", session_id="...")
```
Wait 5s. Then:
```
terminal_wait(terminal_name="spec-case-6", session_id="...")
```
Expected: returns with `[exit code: 0 — completed ~5s ago]`. Output body is `(no output)` because `terminal_run(wait=true)` already drained it (see Task 6 Step 10 note).

Second immediate call:
```
terminal_wait(terminal_name="spec-case-6", session_id="...")
```
Expected: error `Terminal 'spec-case-6' has no active or recent execution.` (cache cleared on read).

- [ ] **Step 7: Bug-fix iteration**

For any reproduction that fails:
1. Diagnose (add temporary `console.log` in the relevant TerminalManager method if needed — VS Code's Pylon output channel catches them).
2. Fix.
3. Re-compile, re-package, re-install, re-reload.
4. Re-run the failing case.
5. Once green, commit the fix:
```bash
git add src/
git commit -m "fix: <brief description of what was wrong>"
```

- [ ] **Step 8: Final commit marking reproduction complete**

Only if no changes in step 7 (otherwise those commits cover it). If you want an explicit marker:
```bash
git commit --allow-empty -m "chore: spec reproduction cases pass"
```

---

## Task 9: Update README and CHANGELOG

**Files:**
- Modify: `README.md` — tools table
- Modify: `CHANGELOG.md` — add 0.5.0 entry
- Modify: `package.json` — bump version

- [ ] **Step 1: Add terminal_wait to README tools table**

Open `README.md`, find the tools table listing `terminal_run`, `terminal_send_text`, `terminal_read_output`, `terminal_clear_buffer`. Add a row for `terminal_wait` with a brief description mirroring the hub-tool description: "Wait for the current/most-recent execution in a terminal to finish, returning output + exit code. Supports progressive check-ins via repeated calls with shorter timeouts."

Also find the `terminal_run` description in the README and update it to mention: new default timeout 300s, busy-terminal refusal, streaming output via progress notifications.

- [ ] **Step 2: Add CHANGELOG entry**

Open `CHANGELOG.md`. Add at the top:

```markdown
## 0.5.0 — Authoritative terminal completion

- `terminal_run` now returns the moment the command actually ends (via `onDidEndTerminalShellExecution`) rather than after a 3-second output-idle heuristic. Eliminates spurious early returns on silent pauses and the ~5s post-completion lag.
- New `terminal_wait` tool: wait for the current (or recently-completed) execution in a terminal, retrieve output + exit code. Supports progressive check-ins via repeated calls.
- `terminal_run` now refuses with a clear error if the target terminal is already running a command (Pylon- or user-typed). Prevents the silent output-corruption / fake exit-code-0 bug.
- Default `timeout_ms` raised from 30000 to 300000. On timeout, commands keep running; use `terminal_wait` to resume.
- When the MCP client provides `_meta.progressToken`, `terminal_run` streams output live via `notifications/progress`.
```

- [ ] **Step 3: Bump version**

In `package.json`, change `"version": "0.4.0"` to `"version": "0.5.0"`.

- [ ] **Step 4: Compile + package**

```bash
npm run compile
vsce package
```
Expected: produces `pylon-0.5.0.vsix`.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs: release 0.5.0 — authoritative terminal completion"
```

- [ ] **Step 6: Tag (optional, defer to user)**

Ask the user whether to tag `v0.5.0` and push. Do not tag or push without explicit confirmation.

---
