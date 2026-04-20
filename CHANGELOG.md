# Changelog

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
