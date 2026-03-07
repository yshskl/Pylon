# Pylon — VS Code MCP Server

Exposes VS Code terminals and IDE features to AI coding agents (Claude Code, Gemini, Cursor, etc.) via a local MCP server. Supports multiple VS Code windows simultaneously through a hub/satellite session model.

**Zero dependencies. No proxy. One HTTP endpoint.**

## Architecture

```
AI Agent (Claude Code / Gemini / any MCP client)
         │  HTTP POST /mcp
         ▼
   Hub (port 27681)  ◄── session registry
         │
         │  HTTP forward (session_id routing)
         ▼
   AgentServer A (port 27691)   ← Window A
   AgentServer B (port 27692)   ← Window B
   AgentServer C (port 27693)   ← Window C
```

**Every VS Code window** runs its own internal AgentServer (port 27691+).
**The first window** to open also starts the Hub on port 27681 — the single MCP endpoint.
**Subsequent windows** register as satellites and send heartbeats. If the hub closes, a satellite auto-promotes.

## Installation

### 1. Build & install the extension

```bash
npm run compile
npm install -g @vscode/vsce
vsce package
code --install-extension pylon-0.2.0.vsix
```

### 2. Add MCP config to your AI agent

The MCP endpoint is always `http://127.0.0.1:27681/mcp`.

**Claude Code** (`~/.claude.json` or via CLI):
```json
{
  "mcpServers": {
    "pylon": {
      "type": "http",
      "url": "http://127.0.0.1:27681/mcp"
    }
  }
}
```
```bash
claude mcp add --transport http pylon http://127.0.0.1:27681/mcp
```

**Gemini / other agents:** use the same URL in their respective MCP config.

### 3. That's it

The extension auto-starts when VS Code opens. The status bar shows the current role:
- `⬡ Pylon Hub: myproject` — this window owns the hub
- `◎ Pylon: myproject` — satellite connected to hub

## Available Tools

### Terminal Tools

| Tool | Description |
|------|-------------|
| `terminal_list_sessions` | **Call first.** Lists all connected VS Code windows with their session IDs. |
| `terminal_list` | List open terminals. Without `session_id`: all sessions. With `session_id`: that window only. |
| `terminal_run` | Execute a command and capture output (requires shell integration). |
| `terminal_send_text` | Send text/keystrokes to a terminal (`\x03` = Ctrl+C, `\x04` = Ctrl+D). |
| `terminal_read_output` | Read buffered terminal output (works on all terminals, no shell integration needed). |
| `terminal_clear_buffer` | Clear the output buffer for a terminal. |

### IDE Tools

| Tool | Description |
|------|-------------|
| `get_diagnostics` | Get VS Code diagnostics (TypeScript errors, ESLint warnings, etc.) from all open files or a specific file. Filter by file path or severity level. |
| `get_document_symbols` | Get the symbol outline of a file (functions, classes, methods, variables) without reading it. Massive token savings for codebase exploration. |
| `get_references` | Find all references/usages of a symbol across the workspace. Critical for understanding blast radius before refactoring. |
| `rename_symbol` | LSP-powered rename that updates all references, imports, and type annotations across the workspace. |
| `run_command` | Execute any VS Code command by ID. Universal escape hatch — format documents, organize imports, toggle settings, and anything else VS Code can do. |

### Editor Tools

| Tool | Description |
|------|-------------|
| `open_file` | Open a file in the editor and jump to a specific line or highlight a range. The human sees the file appear — use to draw attention to code. |
| `format_document` | Format a file using the configured formatter (Prettier, ESLint, etc.) and save. Call after editing to ensure consistent style. |
| `organize_imports` | Remove unused imports, sort remaining imports, and save. Call after refactoring to clean up stale imports. |
| `fix_all` | Apply all auto-fixable diagnostics (ESLint fixes, missing semicolons, etc.) and save. |
| `save_all` | Save all open files with unsaved changes. |
| `find_in_files` | Open the workspace search panel with a query. Supports regex, file include/exclude globs, and find-and-replace. |
| `get_hover_info` | Get type information, documentation, and signatures for a symbol at a position — what you'd see hovering in VS Code. |

### Debug Tools

| Tool | Description |
|------|-------------|
| `debug_breakpoints` | Add, remove, list, or clear breakpoints. Works without an active debug session. Supports conditional breakpoints and logpoints. |
| `debug_start` | Start a debug session by launch.json config name or inline config object. Falls back to the default configuration. |
| `debug_stop` | Stop the active debug session or all sessions. Optionally clear breakpoints on stop. |
| `debug_state` | Full snapshot of current debug state — threads, call stacks, scopes, and variables in one call. No need to chain requests. |
| `debug_control` | Control execution: continue, pause, step over/into/out, restart, or evaluate expressions in the debug context. |
| `debug_console_output` | Read debug console output (console.log, stderr, debugger messages). Captures DAP output events not available via terminal tools. |

All tools accept an optional `session_id` parameter to target a specific VS Code window.

### Diagnostics Example

```
Agent calls: get_diagnostics(severity="error", session_id="frontend")
→ 3 diagnostic(s):
→
→ src/app.ts:42:5 Error [ts]: Property 'foo' does not exist on type 'Bar'.
→ src/utils.ts:10:12 Error [ts]: Cannot find name 'response'.
→ src/index.ts:3:1 Error [eslint]: 'React' must be in scope when using JSX.
```

No need to run `tsc` or `eslint` manually — diagnostics come directly from VS Code's language services in real time.

## Multi-Window / Multi-Agent Usage

Each VS Code workspace is automatically identified by its folder name as a **session ID**.

An AI agent should call `terminal_list_sessions` at the start of a conversation to discover available sessions, identify its own workspace, and use that `session_id` for all subsequent calls. The tool descriptions instruct agents to do this automatically — no manual configuration required.

Example flow:
```
Agent calls: terminal_list_sessions
→ [hub]       session="frontend"  agent=http://127.0.0.1:27691
→ [satellite] session="backend"   agent=http://127.0.0.1:27692

Agent in "backend" workspace then uses:
  terminal_run(command="npm run dev", session_id="backend")
  terminal_read_output(session_id="backend", lines=50)
  get_diagnostics(session_id="backend", severity="error")
```

## Hub Failover

If the hub window closes:
1. Satellites detect the missing heartbeat within ~5 seconds
2. The first satellite to respond claims port 27681 and becomes the new hub
3. Other satellites re-register with the new hub automatically

## Shell Integration Setup

`terminal_run` requires VS Code shell integration to be active. Shell integration provides command boundary tracking and output capture via OSC 633 sequences.

**Check status:** Command Palette → `Pylon: Diagnose Shell Integration`
Shows `shellIntegration=YES/NO` and `cwd` for each terminal. If `cwd=undefined` despite `YES`, the shell isn't sourcing the integration script.

### Per-shell setup

**PowerShell** — works automatically, no setup needed.

**WSL / bash** — add to `~/.bashrc`:
```bash
. "$(code --locate-shell-integration-path bash)"
```

**zsh** — add to `~/.zshrc`:
```bash
. "$(code --locate-shell-integration-path zsh)"
```

**fish** — add to `~/.config/fish/config.fish`:
```fish
source (code --locate-shell-integration-path fish)
```

**CMD** — not supported natively. Install [Clink](https://mridgers.github.io/clink/) for CMD shell integration support.

After adding the script, close and reopen the terminal. Run the diagnose command to confirm `cwd` is no longer `undefined`.

### If PowerShell blocks profile scripts

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

## Output Buffering

Terminal output is buffered via VS Code's shell integration events (`onDidStartTerminalShellExecution`). **Shell integration is required** for buffering — terminals without it will show no buffered output.

`terminal_run` executes a command and returns its output inline. `terminal_read_output` reads the accumulated buffer from all previous commands in that terminal session.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `pylon.port` | `27681` | Hub port — must match the URL in your AI agent's MCP config |
| `pylon.autoStart` | `true` | Auto-start on VS Code launch |
| `pylon.outputBufferLines` | `2000` | Max lines kept per terminal buffer |

## Ports

| Port | Role |
|------|------|
| `27681` (configurable) | Hub — the registered MCP endpoint |
| `27691–27700` | AgentServers — one per VS Code window (auto-assigned) |

## Security

- All servers bind to `127.0.0.1` only — no network exposure
- No authentication — intended for local development use only
- Request bodies capped at 1 MB
