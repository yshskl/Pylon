# Terminal completion model redesign

**Status:** Draft for implementation
**Date:** 2026-04-20
**Component:** `src/terminalManager.ts`, `src/hubServer.ts`, `src/agentServer.ts`

## Problem

The current `terminal_run` implementation in [terminalManager.ts:182-280](../../../src/terminalManager.ts) uses a 3-second output-idle heuristic to decide when a command is "done enough to return." This heuristic is wrong in three observable ways:

1. **Spurious early returns.** Any command with a silent pause ≥3s (e.g. `sleep 5; echo x`, `npm install` decision points, `docker pull` layer gaps) returns with a `[Output idle for 3s — command still running]` marker and no exit code, even when the command is genuinely mid-execution.

2. **Silent corruption of busy terminals.** When Claude acts on a premature "settled" response by calling `terminal_run` again against the same terminal, `shellIntegration.executeCommand` on a busy shell returns almost instantly with a fake `exit code: 0`. Output from the first command is permanently truncated. Reproduced live: `echo start; sleep 5; echo middle; sleep 5; echo end` followed by `echo SECOND_COMMAND` on the same terminal loses the `end` line forever.

3. **Perceived latency even on correct completions.** When a command ends cleanly, a 3s idle timer and up to a 2s exit-code grace window ([line 264](../../../src/terminalManager.ts#L264)) add up to ~5s of post-completion lag visible to Claude.

The underlying cause: Pylon ignores VS Code's authoritative `onDidEndTerminalShellExecution` event in favor of guessing from output silence. Shell integration already provides a definitive completion signal; the current code just doesn't use it as the source of truth.

## Goals

- Return from `terminal_run` the moment the command actually ends — no sooner, no later.
- Real exit codes on every successful completion.
- Never silently corrupt a busy terminal.
- Give Claude a clean way to run long commands without blocking its turn for minutes.
- Let Claude progressively check on long-running commands rather than one blocking call.

## Non-goals

- True push callbacks from Pylon to Claude between turns. Not possible given Claude's agent loop; MCP progress notifications during an open call are the closest equivalent and are part of this design.
- Changes to the hub/satellite architecture, session routing, or multi-window logic.
- Changes to any non-terminal tools.

## Design

### 1. Completion model in `executeCommand`

Remove the idle-settle branch entirely. The race in [terminalManager.ts:253](../../../src/terminalManager.ts#L253) collapses from three ways (read-done, idle, timeout) to two (read-done, timeout).

```
start execution via shellIntegration.executeCommand(command)
subscribe to onDidEndTerminalShellExecution for this execution (captures exit code)
for await chunk of execution.read():
    append to output + passive buffer
    if client sent progressToken: emit MCP progress notification with chunk
when execution.read() iterator closes → command ended, exit code already known
return { output, exit_code, timed_out: false }

if timeout_ms fires first:
    do NOT dispose the execution — command keeps running
    keep the terminal in the busy state
    return { output_so_far, exit_code: undefined, timed_out: true,
             hint: "[STILL RUNNING — use terminal_wait to resume]" }
```

**Consequences:**

- No early return on silent pauses. The 3s idle tax disappears.
- Exit code is always real when `timed_out: false`. The end-event subscription resolves `exitCode` independently of the read loop; in practice shell integration fires the end event by the time the read iterator closes, but even if it races slightly after, the existing 2s grace window ([line 264](../../../src/terminalManager.ts#L264)) is preserved as a minimum and is the only remaining source of post-completion delay. In the common case it resolves immediately.
- On timeout, the response explicitly signals "still running." Claude must use `terminal_wait` (or `terminal_send_text "\x03"` to abort) — not a fresh `terminal_run`, which will refuse because the terminal is busy.

**`wait=false` behavior:** start the execution and register it in `activeExecutions` exactly as in the blocking path, but return immediately without consuming the read iterator. A background task still drains `execution.read()` into `ExecutionState.output` so `terminal_wait` can deliver accumulated chunks later. Response text:
```
Command started in terminal '<name>': <command>
Use terminal_wait (terminal_name='<name>') to retrieve output and exit code.
```
The busy-check and user-command-busy rules apply the same way: `wait=false` against a busy terminal refuses.

### 2. Busy-state tracking

New field on `TerminalManager`: `activeExecutions: Map<string, ExecutionState>`, keyed by terminal name.

```typescript
interface ExecutionState {
  execution: vscode.TerminalShellExecution;
  commandLine: string;
  startedAt: number;
  output: string;          // accumulating from start, full history
  deliveredLength: number; // how much of `output` has already been returned to a previous
                           // terminal_run/terminal_wait caller; the next caller gets the slice
                           // from this offset forward
  endPromise: Promise<number | undefined>;  // resolves with exit code
}
```

**Incremental output semantics.** Each `terminal_run` (blocking call) and each `terminal_wait` call returns only the output produced since the previous delivery — the slice `output.slice(deliveredLength)`. After returning, `deliveredLength` is updated to `output.length`. This means a progressive check-in pattern (`terminal_run(wait=false)` → repeated `terminal_wait`) gets non-overlapping chunks of output, not the full history each time. The full buffered history remains available via `terminal_read_output` as today.

Populated by both `onDidStartTerminalShellExecution` (covers user-typed commands) and our own `executeCommand` path. Cleared on `onDidEndTerminalShellExecution`. `ownExecutions` stays as-is; its only job is letting the passive listener skip our own iterations.

When `terminal_run` is called and the target terminal has an active execution:
```
throw new Error(
  `Terminal '${name}' is busy running: ${activeExecution.commandLine}. ` +
  `Use terminal_wait to wait for completion, terminal_send_text to provide input ` +
  `or abort with '\\x03', or target a different terminal.`
);
```

This catches both Pylon-initiated and user-typed commands.

### 3. New tool: `terminal_wait`

Parameters:
- `terminal_name: string` (required — no "active terminal" fallback; explicit targeting only)
- `timeout_ms: number` (default 300000)
- `session_id: string` (standard multi-window param)

Behavior:
- If `activeExecutions` has an entry for the terminal: block up to `timeout_ms` on that entry's end. On return, deliver the incremental slice `output.slice(deliveredLength)` (the portion not yet returned to any prior `terminal_run`/`terminal_wait` caller) plus exit code if completed. `deliveredLength` is updated after the slice is prepared.
- If no active execution but one finished within the last 60s: return that cached result. Cache is cleared on read.
- Otherwise: error `"Terminal 'X' has no active or recent execution."`

Response text format (matches existing conventions):
```
<output>
[exit code: N]
```
or on timeout:
```
<partial output>
[STILL RUNNING — Ns elapsed, no exit yet. Call terminal_wait again or send '\x03' via terminal_send_text to abort.]
```
or on cached result:
```
<cached output>
[exit code: N — completed Xs ago]
```

Concurrent `terminal_wait` calls on the same terminal both subscribe to the same end event. The first to consume the incremental slice updates `deliveredLength` to `output.length`; the second call receives an empty output slice but the same exit code. Expected behavior — the use case for concurrent waits is rare, and at least one caller gets the content.

### 4. Last-result cache

On `onDidEndTerminalShellExecution`:
1. Resolve any pending `terminal_wait` callers (which apply the `deliveredLength` slicing before returning).
2. Move the execution state to `recentResults: Map<string, RecentResult>` with a timestamp.
3. Clear after 60s OR on first `terminal_wait` read (whichever comes first).

```typescript
interface RecentResult {
  undeliveredOutput: string;  // output.slice(deliveredLength) at the moment of completion
  exitCode: number | undefined;
  finishedAt: number;
}
```

So after a `terminal_run(wait=true)` that returned the full output cleanly, `undeliveredOutput` is empty and a subsequent `terminal_wait` returns just the exit code with `"(no new output)"`. After a `terminal_run(wait=false)` with no intermediate `terminal_wait` call, `undeliveredOutput` is the full output.

### 5. MCP progress notifications

Pylon's MCP handler is in [hubServer.ts](../../../src/hubServer.ts). Add:
1. On incoming tool calls, extract `_meta.progressToken` if present.
2. Pass the token through `routeToolCall` → `AgentServer.callTool` → `TerminalManager.executeCommand`.
3. When `executeCommand` receives output chunks and a token is set, send a `notifications/progress` JSON-RPC message back on the same HTTP connection with:
   ```
   { method: "notifications/progress",
     params: { progressToken, progress: <bytes received>, message: <chunk> } }
   ```
4. If no token present, skip — final result still returns normally. No regression for clients that don't support streaming.

### 6. Shell integration unavailable

Existing 8s `waitForShellIntegration` logic at [line 191](../../../src/terminalManager.ts#L191) stays. On persistent unavailability, the fallback message is updated to:
```
[Shell integration unavailable — command sent via sendText. terminal_wait and exit codes
won't work for this terminal. Enable: terminal.integrated.shellIntegration.enabled = true]
```

### 7. Tool descriptions (exact wording)

**`terminal_run`:**
```
Execute a shell command in a VS Code terminal and capture output. Requires shell integration.

Blocks until the command finishes or timeout_ms elapses (default 300000 = 5 min). Output
streams live via progress notifications while blocking. On timeout, the command keeps running
and the response ends with '[STILL RUNNING — ...]' — call terminal_wait to resume.

For commands expected to exceed ~30s (builds, installs, long tests), prefer wait=false +
progressive terminal_wait calls starting at timeout_ms=10000 then 30000. Between waits you
can read partial output, send input with terminal_send_text, or abort with '\x03'.

If the target terminal is busy (Pylon- OR user-typed command still running), this call refuses
with an error naming the active command. Pick a different terminal or call terminal_wait first.

Returns final output with '[exit code: N]' on success. Always include session_id.
```

**`terminal_wait`:**
```
Wait for the current (or most recent) execution in a terminal to finish, and return its
output and exit code. Blocks up to timeout_ms (default 300000). On timeout, returns output
accumulated during this wait with '[STILL RUNNING — ...]' — call again to continue waiting,
or send '\x03' via terminal_send_text to abort.

Use this to retrieve results after terminal_run(wait=false), to progressively check on a
long-running command, or to wait for a user-typed command in a shared terminal.

If the terminal has no active execution but one finished within the last 60s, returns that
cached result. Otherwise errors. Always include session_id.
```

**`terminal_send_text` description clarification:**
```
Send text/input to a terminal WITHOUT capturing output. Works on busy terminals — this is
how you answer prompts in a running command or abort it (send '\x03' for Ctrl+C, '\x04'
for Ctrl+D). Use terminal_wait afterward to retrieve the result of the interrupted command.
```

`terminal_read_output` and `terminal_clear_buffer` descriptions unchanged.

## Edge cases

1. **Terminal closed while a command is running.** `onDidCloseTerminal` fires → `activeExecutions` entry deleted; any pending `terminal_wait` rejects with `"Terminal 'X' closed while waiting."` Buffer flush at [line 108](../../../src/terminalManager.ts#L108) unchanged.

2. **Shell integration never becomes available.** Current 8s wait stays. Fallback message updated per section 6.

3. **Two concurrent `terminal_wait` calls on the same terminal.** Both subscribe to the same end event. The first to consume the incremental slice updates `deliveredLength` to `output.length`; the second gets an empty output slice but the same exit code.

4. **`wait=false` plus user interference.** If Claude starts a background command and the user types something in that terminal, shell integration handles serialization (queued via stdin or refused). We don't try to prevent this; terminals are shared by design. `terminal_wait` returns what shell integration reports for the first execution.

5. **No `progressToken` in the MCP request.** Skip progress notifications silently; final result returns normally.

6. **Last-result cache timing.** 60s window starts at execution end. Exactly one `terminal_wait` consumes it. Simpler than ref-counting; matches the "Claude calls wait once per command" pattern.

7. **Command with zero output.** Returns `"(no output)"` as today; `exit_code` is the meaningful signal.

8. **`terminal_run` against a non-existent terminal.** Unchanged — creates the terminal via shell resolution, then runs. New terminal has no active execution, so the busy check passes.

## Files to change

- **`src/terminalManager.ts`** — rewrite `executeCommand`, add `activeExecutions` + `recentResults` maps, add `waitForExecution` method that powers `terminal_wait`, extend `setupListeners` to track starts/ends for user-typed commands too.
- **`src/hubServer.ts`** — add `HUB_TOOLS` entry for `terminal_wait`, update `terminal_run` / `terminal_send_text` descriptions, add `progressToken` extraction and plumbing.
- **`src/agentServer.ts`** — add `case 'terminal_wait':` handler, update `case 'terminal_run':` to accept and forward the progress-emit callback.

## Testing

Reproduction cases from the live testing session that must pass:

- `echo start; sleep 5; echo middle; sleep 5; echo end` → returns after ~10s with full output (`start`, `middle`, `end`) and `exit code: 0`. No "idle" marker, no truncation.
- Same command with `timeout_ms=3000` → returns at 3s with partial output and `[STILL RUNNING ...]` marker; command continues; `terminal_wait` call 7s later returns the remaining output and `exit code: 0`.
- `terminal_run` on a terminal that's currently executing → refuses with the busy-error message naming the active command.
- `terminal_run(wait=false, command="sleep 2 && echo done")` → returns instantly; `terminal_wait(timeout_ms=5000)` returns `done` and `exit code: 0`.
- User types `sleep 30` manually; Claude calls `terminal_run` on that terminal → refused with busy error.
- `terminal_wait` against an idle terminal whose last command finished 5s ago → returns the cached result with `[completed Xs ago]` marker. Second `terminal_wait` call against the same idle terminal → errors (cache cleared).

## Out of scope

- Replacing HTTP transport or changing the hub/satellite architecture.
- Changes to non-terminal tools.
- Windows-specific shell integration quirks beyond what current code handles.
- Per-chunk rate-limiting of progress notifications (VS Code's shell integration chunks output reasonably; if this becomes a problem in practice, batch later).
