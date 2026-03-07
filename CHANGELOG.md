# Changelog

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
