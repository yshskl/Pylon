# Changelog

## 0.6.0 — MCP 2026-07-28, reverse channel, security fix

### Security
- **Browser-reachable command execution is closed.** Both servers sent
  `Access-Control-Allow-Origin: *` and validated no headers, so any web page the user visited
  could POST a `tools/call` to the hub, run shell commands and read the output. Requests
  carrying an `Origin`, or a `Host` that is not loopback, are now refused with 403; no CORS
  headers are served at all. **Any AI agent is unaffected** — none of them send either header.
- Session registration now only accepts an `agentUrl` on `127.0.0.1`, so forwarded tool
  output cannot be routed off the machine.
- Internal planning documents are no longer packaged into the VSIX.

### Added
- **MCP 2026-07-28** alongside the older revisions, chosen per request: `server/discover`,
  header validation (`-32020`), version negotiation (`-32022`), `resultType` and cache hints.
- **Resources** — `pylon://sessions`, `.../diagnostics`, `.../debug/state`,
  `.../terminal/{name}/buffer` — and `subscriptions/listen` to be told when they change.
- **Progress from satellite windows.** `POST /tool` answers SSE when the hub has somewhere to
  forward chunks to, falling back to a buffered reply against an older Pylon.
- `GET /events`, a reverse channel the hub opens to each satellite, reconciled every 5s.
- `debug_state` reports why the debugger stopped, from the DAP event that was being discarded.
- `/sessions/unregister`, so a closing window is not mistaken for a crashed one for 15s.

### Fixed
- Satellite tool errors reached the agent as a result with no `content`; the aggregated
  `terminal_list` reported every failure as `(unreachable)` regardless of cause.
- HTTP helpers treated every status as success, so a satellite the hub had forgotten
  heartbeat into the void forever instead of re-registering.
- Request timeouts bounded socket idleness, not the exchange — a trickling peer could stall
  activation indefinitely.
- Stopping Pylon hung while any stream was open; sockets are now released.
- A failed hub promotion left the window orphaned with no retry and a green status bar.
- Multi-byte characters were corrupted at chunk boundaries in request bodies and in streamed
  terminal output; ANSI sequences split across chunks leaked into the stream.
- A leaked listener on every shell-integration timeout; unbounded per-execution output.

## 0.5.0 — Authoritative terminal completion

### Added
- **`terminal_wait` tool** — Wait for the current (or recently-completed) execution in a terminal to finish, returning output and exit code. Supports progressive check-ins via repeated calls with shorter timeouts.

### Changed
- **`terminal_run` authoritativeness** — Now returns the moment the command actually ends (via `onDidEndTerminalShellExecution`) rather than after a 3-second output-idle heuristic. Eliminates spurious early returns on silent pauses and the ~5s post-completion lag.
- **`terminal_run` busy-terminal safety** — Now refuses with a clear error if the target terminal is already running a command (Pylon-invoked or user-typed). Prevents the silent output-corruption / fake exit-code-0 bug.
- **`terminal_run` default timeout** — Raised from 30000 to 300000 ms. On timeout, commands keep running; use `terminal_wait` to resume polling.
- **`terminal_run` progress streaming** — When the MCP client provides `_meta.progressToken`, streams output live via `notifications/progress` instead of waiting until completion.

## 0.4.0

### Fixed
- **Terminal shell resolution** — creating a terminal by name (e.g. "PowerShell") now opens the correct shell instead of the default profile. Checks VS Code terminal profiles first, falls back to well-known shell executables.

### Changed
- **Smart command output** — `terminal_run` now returns early when output settles (3s idle) instead of blocking until the full timeout for long-running commands (servers, watchers)
- **`wait` parameter** — `terminal_run` accepts `wait: false` to fire-and-forget commands; use `terminal_read_output` to check results later
- Improved tool descriptions to guide agents on using `terminal_read_output` for incomplete output

## 0.3.0

### Added
- **Tool Access Control** — `pylon.disabledTools` blocklist setting and `Pylon: Configure Tool Access` visual picker command (grouped by category)
- **Debug Console Output** — `debug_console_output` tool captures DAP output events (console.log, stderr, debugger messages) not available via terminal tools
- **Status bar** — "Configure Tools" button in the Pylon status popup

### Changed
- Version bump to 0.3.0

## 0.2.0

### Added
- **Editor Tools** (7) — `open_file`, `format_document`, `organize_imports`, `fix_all`, `save_all`, `find_in_files`, `get_hover_info`
- **Debug Tools** (5) — `debug_breakpoints`, `debug_start`, `debug_stop`, `debug_state`, `debug_control`
- **IDE Tools** — `run_command` (execute any VS Code command by ID)

## 0.1.0

### Added
- **Terminal Tools** (6) — `terminal_list_sessions`, `terminal_list`, `terminal_run`, `terminal_send_text`, `terminal_read_output`, `terminal_clear_buffer`
- **IDE Tools** — `get_diagnostics`, `get_document_symbols`, `get_references`, `rename_symbol`
- Hub/satellite multi-window architecture with auto-failover
- Zero dependencies, direct HTTP MCP transport
