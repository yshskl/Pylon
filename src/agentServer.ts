import * as http from 'http';
import * as vscode from 'vscode';
import { TerminalManager } from './terminalManager';

export interface ToolResult {
    content: Array<{ type: string; text: string }>;
}

export class AgentServer {
    private server: http.Server | null = null;
    private terminalManager: TerminalManager;
    private debugOutputBuffer: string[] = [];
    private maxDebugOutputLines: number;
    port = 0;

    constructor(terminalManager: TerminalManager, maxDebugOutputLines = 2000) {
        this.terminalManager = terminalManager;
        this.maxDebugOutputLines = maxDebugOutputLines;
    }

    start(basePort = 27691): Promise<number> {
        const MAX_ATTEMPTS = 10;
        const tryPort = (attempt: number): Promise<number> => {
            if (attempt >= MAX_ATTEMPTS) {
                return Promise.reject(
                    new Error(`No available agent port in range ${basePort}–${basePort + MAX_ATTEMPTS - 1}`)
                );
            }
            const candidatePort = basePort + attempt;
            return new Promise((resolve, reject) => {
                const server = http.createServer((req, res) => {
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

                    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

                    if (req.method === 'GET' && req.url === '/health') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'ok' }));
                        return;
                    }

                    if (req.method === 'POST' && req.url === '/tool') {
                        let body = '';
                        let bodySize = 0;
                        const MAX_BODY = 1024 * 1024; // 1 MB
                        req.on('data', (chunk) => {
                            bodySize += chunk.length;
                            if (bodySize <= MAX_BODY) { body += chunk; }
                        });
                        req.on('end', async () => {
                            if (bodySize > MAX_BODY) {
                                res.writeHead(413, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Request body too large' }));
                                return;
                            }
                            try {
                                const { tool, params } = JSON.parse(body) as {
                                    tool: string;
                                    params: Record<string, unknown>;
                                };
                                const result = await this.callTool(tool, params);
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify(result));
                            } catch (e) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: String(e) }));
                            }
                        });
                        return;
                    }

                    res.writeHead(404);
                    res.end();
                });

                server.on('error', (e: NodeJS.ErrnoException) => {
                    server.close();
                    if (e.code === 'EADDRINUSE') {
                        tryPort(attempt + 1).then(resolve, reject);
                    } else {
                        reject(e);
                    }
                });

                server.listen(candidatePort, '127.0.0.1', () => {
                    this.server = server;
                    this.port = candidatePort;
                    resolve(candidatePort);
                });
            });
        };
        return tryPort(0);
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) { resolve(); return; }
            this.server.close(() => { this.server = null; resolve(); });
        });
    }

    get isRunning(): boolean {
        return this.server !== null && this.server.listening;
    }

    appendDebugOutput(output: string, category?: string): void {
        const prefix = category && category !== 'stdout' ? `[${category}] ` : '';
        const lines = output.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/\r$/, '');
            if (i === lines.length - 1 && line === '') continue;
            this.debugOutputBuffer.push(prefix + line);
        }
        if (this.debugOutputBuffer.length > this.maxDebugOutputLines) {
            this.debugOutputBuffer.splice(0, this.debugOutputBuffer.length - this.maxDebugOutputLines);
        }
    }

    readDebugOutput(lines?: number): string {
        if (this.debugOutputBuffer.length === 0) return '(no debug output)';
        const slice = lines ? this.debugOutputBuffer.slice(-lines) : this.debugOutputBuffer;
        return slice.join('\n');
    }

    clearDebugOutput(): void {
        this.debugOutputBuffer = [];
    }

    private async expandVariables(
        session: vscode.DebugSession,
        variablesReference: number,
        depth: number,
        maxDepth: number,
        indent: number,
        output: string[],
        visited = new Set<number>(),
    ): Promise<void> {
        if (variablesReference === 0 || depth > maxDepth || visited.has(variablesReference)) return;
        visited.add(variablesReference);
        const resp = await session.customRequest('variables', { variablesReference });
        const vars: Array<{ name: string; value: string; variablesReference: number }> =
            resp.variables ?? [];
        const prefix = '  '.repeat(indent);
        for (const v of vars) {
            output.push(`${prefix}${v.name} = ${v.value}`);
            if (v.variablesReference > 0 && depth + 1 <= maxDepth) {
                await this.expandVariables(session, v.variablesReference, depth + 1, maxDepth, indent + 1, output, visited);
            }
        }
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });

        switch (name) {
            case 'terminal_list': {
                const terminals = this.terminalManager.listTerminals();
                if (terminals.length === 0) return text('No terminals open.');
                const lines = terminals.map(
                    (t) =>
                        `[${t.id}] "${t.name}"${t.isActive ? ' (active)' : ''}${t.hasShellIntegration ? ' [shell-integration]' : ' [no shell-integration]'
                        }`
                );
                return text(lines.join('\n'));
            }

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

            case 'terminal_send_text': {
                const rawText = args.text as string;
                const processed = rawText
                    .replace(/\\x03/g, '\x03')
                    .replace(/\\x04/g, '\x04')
                    .replace(/\\n/g, '\n');
                const terminalName = args.terminal_name as string | undefined;
                const addNewline = (args.add_newline as boolean | undefined) ?? true;
                this.terminalManager.sendText(processed, terminalName, addNewline);
                return text(`Text sent to terminal${terminalName ? ` "${terminalName}"` : ''}.`);
            }

            case 'terminal_read_output': {
                const terminalName = args.terminal_name as string | undefined;
                const lines = args.lines as number | undefined;
                return text(this.terminalManager.readOutput(terminalName, lines));
            }

            case 'terminal_clear_buffer': {
                const terminalName = args.terminal_name as string | undefined;
                this.terminalManager.clearBuffer(terminalName);
                return text('Buffer cleared.');
            }

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

            case 'get_diagnostics': {
                const uri = args.uri as string | undefined;
                const severity = args.severity as string | undefined;

                const severityMap: Record<string, vscode.DiagnosticSeverity> = {
                    error: vscode.DiagnosticSeverity.Error,
                    warning: vscode.DiagnosticSeverity.Warning,
                    information: vscode.DiagnosticSeverity.Information,
                    hint: vscode.DiagnosticSeverity.Hint,
                };
                const severityNames: Record<number, string> = {
                    [vscode.DiagnosticSeverity.Error]: 'Error',
                    [vscode.DiagnosticSeverity.Warning]: 'Warning',
                    [vscode.DiagnosticSeverity.Information]: 'Information',
                    [vscode.DiagnosticSeverity.Hint]: 'Hint',
                };
                const filterSeverity = severity ? severityMap[severity] : undefined;

                let allDiagnostics: [vscode.Uri, vscode.Diagnostic[]][];
                if (uri) {
                    const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                    const diags = vscode.languages.getDiagnostics(fileUri);
                    allDiagnostics = diags.length > 0 ? [[fileUri, diags]] : [];
                } else {
                    allDiagnostics = vscode.languages.getDiagnostics();
                }

                const lines: string[] = [];
                let totalCount = 0;

                for (const [fileUri, diagnostics] of allDiagnostics) {
                    const filtered = filterSeverity !== undefined
                        ? diagnostics.filter((d) => d.severity === filterSeverity)
                        : diagnostics;
                    if (filtered.length === 0) continue;

                    const relPath = vscode.workspace.asRelativePath(fileUri);
                    for (const d of filtered) {
                        const sev = severityNames[d.severity] || 'Unknown';
                        const line = d.range.start.line + 1;
                        const col = d.range.start.character + 1;
                        const source = d.source ? ` [${d.source}]` : '';
                        lines.push(`${relPath}:${line}:${col} ${sev}${source}: ${d.message}`);
                        totalCount++;
                    }
                }

                if (totalCount === 0) {
                    return text(uri ? `No diagnostics for ${uri}.` : 'No diagnostics found.');
                }
                return text(`${totalCount} diagnostic(s):\n\n${lines.join('\n')}`);
            }

            case 'get_document_symbols': {
                const uri = args.uri as string;
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    fileUri
                );
                if (!symbols || symbols.length === 0) {
                    return text(`No symbols found in ${uri}. The file may not have a language server active.`);
                }

                const symbolKindName = (kind: vscode.SymbolKind): string => vscode.SymbolKind[kind] || 'Unknown';

                const lines: string[] = [];
                const walk = (syms: vscode.DocumentSymbol[], indent: number) => {
                    for (const s of syms) {
                        const prefix = '  '.repeat(indent);
                        const range = `${s.range.start.line + 1}–${s.range.end.line + 1}`;
                        lines.push(`${prefix}${symbolKindName(s.kind)} ${s.name} [${range}]`);
                        if (s.children && s.children.length > 0) {
                            walk(s.children, indent + 1);
                        }
                    }
                };
                walk(symbols, 0);
                return text(`${lines.length} symbol(s) in ${vscode.workspace.asRelativePath(fileUri)}:\n\n${lines.join('\n')}`);
            }

            case 'get_references': {
                const uri = args.uri as string;
                const line = args.line as number;
                const character = args.character as number;
                if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
                    return text('Error: line and character must be non-negative integers.');
                }
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const position = new vscode.Position(line, character);
                const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeReferenceProvider',
                    fileUri,
                    position
                );
                if (!locations || locations.length === 0) {
                    return text(`No references found at ${uri}:${line}:${character}.`);
                }
                const MAX_REFS = 500;
                const lines: string[] = locations.map((loc) => {
                    const relPath = vscode.workspace.asRelativePath(loc.uri);
                    const l = loc.range.start.line + 1;
                    const c = loc.range.start.character + 1;
                    return `${relPath}:${l}:${c}`;
                });
                const output = lines.slice(0, MAX_REFS).join('\n');
                const suffix = lines.length > MAX_REFS ? `\n... and ${lines.length - MAX_REFS} more.` : '';
                return text(`${locations.length} reference(s):\n\n${output}${suffix}`);
            }

            case 'rename_symbol': {
                const uri = args.uri as string;
                const line = args.line as number;
                const character = args.character as number;
                if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
                    return text('Error: line and character must be non-negative integers.');
                }
                const newName = args.new_name as string;
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const position = new vscode.Position(line, character);

                // Step 1: Check if rename is possible via prepareRename
                let prepareResult: unknown;
                try {
                    prepareResult = await vscode.commands.executeCommand(
                        'vscode.prepareRename',
                        fileUri,
                        position
                    );
                } catch (prepErr) {
                    return text(`Cannot rename at ${uri}:${line}:${character} — ${prepErr}`);
                }
                if (!prepareResult) {
                    return text(`Cannot rename symbol at ${uri}:${line}:${character}. The element at this position is not renameable.`);
                }

                // Step 2: Execute the rename
                const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
                    'vscode.executeDocumentRenameProvider',
                    fileUri,
                    position,
                    newName
                );
                if (!edit) {
                    return text(`Cannot rename symbol at ${uri}:${line}:${character}. No rename provider available.`);
                }
                const entries = edit.entries();
                if (entries.length === 0) {
                    return text('Rename produced no changes.');
                }
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    return text('Failed to apply rename edit.');
                }
                const totalEdits = entries.reduce((sum, [, edits]) => sum + edits.length, 0);
                const fileList = entries.map(([u]) => vscode.workspace.asRelativePath(u));
                // Save only the affected files so the rename is persisted to disk
                for (const [affectedUri] of entries) {
                    const doc = await vscode.workspace.openTextDocument(affectedUri);
                    if (doc.isDirty) { await doc.save(); }
                }
                return text(`Renamed to "${newName}" — ${totalEdits} edit(s) across ${entries.length} file(s):\n${fileList.join('\n')}`);
            }

            case 'run_command': {
                const command = args.command as string;
                const commandArgs = args.args as unknown[] | undefined;
                try {
                    const result = commandArgs
                        ? await vscode.commands.executeCommand(command, ...commandArgs)
                        : await vscode.commands.executeCommand(command);
                    if (result === undefined || result === null) {
                        return text(`Command "${command}" executed.`);
                    }
                    if (typeof result === 'string') {
                        return text(result);
                    }
                    return text(JSON.stringify(result, null, 2));
                } catch (e) {
                    return text(`Command "${command}" failed: ${e}`);
                }
            }

            // ── Editor Tools ──────────────────────────────────────────────

            case 'open_file': {
                const file = args.file as string;
                const line = args.line as number | undefined;
                const endLine = args.end_line as number | undefined;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);

                const doc = await vscode.workspace.openTextDocument(fileUri);
                const editor = await vscode.window.showTextDocument(doc);

                if (line !== undefined) {
                    const startLine = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
                    const startPos = new vscode.Position(startLine, 0);
                    const endPos = endLine
                        ? new vscode.Position(
                            Math.min(endLine - 1, doc.lineCount - 1),
                            doc.lineAt(Math.min(endLine - 1, doc.lineCount - 1)).text.length
                        )
                        : startPos;
                    editor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenter);
                    editor.selection = new vscode.Selection(startPos, endPos);
                }

                const rel = vscode.workspace.asRelativePath(fileUri);
                return text(`Opened ${rel}${line ? ` at line ${line}` : ''}${endLine ? `–${endLine}` : ''}`);
            }

            case 'format_document': {
                const file = args.file as string;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);

                const config = vscode.workspace.getConfiguration('editor', fileUri);
                const options: vscode.FormattingOptions = {
                    tabSize: config.get<number>('tabSize', 4),
                    insertSpaces: config.get<boolean>('insertSpaces', true),
                };

                const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
                    'vscode.executeFormatDocumentProvider',
                    fileUri,
                    options
                );

                if (!edits || edits.length === 0) {
                    return text(`No formatting changes needed for ${vscode.workspace.asRelativePath(fileUri)}.`);
                }

                const wsEdit = new vscode.WorkspaceEdit();
                for (const edit of edits) {
                    wsEdit.replace(fileUri, edit.range, edit.newText);
                }
                await vscode.workspace.applyEdit(wsEdit);

                const doc = await vscode.workspace.openTextDocument(fileUri);
                if (doc.isDirty) await doc.save();

                return text(`Formatted ${vscode.workspace.asRelativePath(fileUri)} (${edits.length} edit(s) applied).`);
            }

            case 'organize_imports': {
                const file = args.file as string;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const fullRange = doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0));

                const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
                    'vscode.executeCodeActionProvider',
                    fileUri,
                    fullRange,
                    vscode.CodeActionKind.SourceOrganizeImports.value
                );

                if (!actions || actions.length === 0) {
                    return text(`No import changes needed for ${vscode.workspace.asRelativePath(fileUri)}.`);
                }

                for (const action of actions) {
                    if (action.edit) {
                        await vscode.workspace.applyEdit(action.edit);
                    }
                }

                if (doc.isDirty) await doc.save();
                return text(`Organized imports in ${vscode.workspace.asRelativePath(fileUri)}.`);
            }

            case 'fix_all': {
                const file = args.file as string;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const fullRange = doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0));

                const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
                    'vscode.executeCodeActionProvider',
                    fileUri,
                    fullRange,
                    vscode.CodeActionKind.SourceFixAll.value
                );

                if (!actions || actions.length === 0) {
                    return text(`No auto-fixable issues in ${vscode.workspace.asRelativePath(fileUri)}.`);
                }

                let fixCount = 0;
                for (const action of actions) {
                    if (action.edit) {
                        await vscode.workspace.applyEdit(action.edit);
                        fixCount++;
                    }
                }

                if (fixCount === 0) {
                    return text(`No auto-fixable issues in ${vscode.workspace.asRelativePath(fileUri)}.`);
                }
                if (doc.isDirty) await doc.save();
                return text(`Applied ${fixCount} fix(es) in ${vscode.workspace.asRelativePath(fileUri)}.`);
            }

            case 'save_all': {
                await vscode.workspace.saveAll(false);
                return text('All files saved.');
            }

            case 'find_in_files': {
                const query = args.query as string;
                const replace = args.replace as string | undefined;
                const isRegex = args.is_regex as boolean | undefined;
                const include = args.include as string | undefined;
                const exclude = args.exclude as string | undefined;

                await vscode.commands.executeCommand('workbench.action.findInFiles', {
                    query,
                    replace,
                    isRegex: isRegex ?? false,
                    filesToInclude: include ?? '',
                    filesToExclude: exclude ?? '',
                    triggerSearch: true,
                });

                return text(`Search opened for "${query}"${replace ? ` with replace "${replace}"` : ''}.`);
            }

            case 'get_hover_info': {
                const uri = args.uri as string;
                const line = args.line as number;
                const character = args.character as number;
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const position = new vscode.Position(line, character);

                const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    fileUri,
                    position
                );

                if (!hovers || hovers.length === 0) {
                    return text(`No hover info at ${vscode.workspace.asRelativePath(fileUri)}:${line}:${character}.`);
                }

                const parts: string[] = [];
                for (const hover of hovers) {
                    for (const content of hover.contents) {
                        if (typeof content === 'string') {
                            parts.push(content);
                        } else if ('value' in content) {
                            parts.push(content.value);
                        }
                    }
                }

                return text(parts.join('\n\n'));
            }

            // ── Debug Tools ──────────────────────────────────────────────

            case 'debug_breakpoints': {
                const action = args.action as string;

                if (action === 'list') {
                    const bps = vscode.debug.breakpoints;
                    if (bps.length === 0) return text('No breakpoints set.');
                    const lines: string[] = [];
                    for (const bp of bps) {
                        if (bp instanceof vscode.SourceBreakpoint) {
                            const loc = bp.location;
                            const rel = vscode.workspace.asRelativePath(loc.uri);
                            const line = loc.range.start.line + 1;
                            let desc = `${rel}:${line}`;
                            if (bp.condition) desc += ` condition="${bp.condition}"`;
                            if (bp.hitCondition) desc += ` hitCondition="${bp.hitCondition}"`;
                            if (bp.logMessage) desc += ` log="${bp.logMessage}"`;
                            if (!bp.enabled) desc += ' (disabled)';
                            lines.push(desc);
                        } else if (bp instanceof vscode.FunctionBreakpoint) {
                            let desc = `function: ${bp.functionName}`;
                            if (bp.condition) desc += ` condition="${bp.condition}"`;
                            if (!bp.enabled) desc += ' (disabled)';
                            lines.push(desc);
                        }
                    }
                    return text(`${lines.length} breakpoint(s):\n${lines.join('\n')}`);
                }

                if (action === 'clear') {
                    const bps = vscode.debug.breakpoints;
                    if (bps.length === 0) return text('No breakpoints to clear.');
                    vscode.debug.removeBreakpoints(bps);
                    return text(`Cleared ${bps.length} breakpoint(s).`);
                }

                // add / remove require file + line
                const file = args.file as string | undefined;
                const line = args.line as number | undefined;
                if (!file || line === undefined) {
                    return text('Error: "file" and "line" are required for add/remove.');
                }
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const position = new vscode.Position(line - 1, 0); // 1-based → 0-based
                const location = new vscode.Location(fileUri, position);

                if (action === 'add') {
                    const bp = new vscode.SourceBreakpoint(
                        location,
                        true, // enabled
                        args.condition as string | undefined,
                        args.hit_condition as string | undefined,
                        args.log_message as string | undefined,
                    );
                    vscode.debug.addBreakpoints([bp]);
                    const rel = vscode.workspace.asRelativePath(fileUri);
                    return text(`Breakpoint added: ${rel}:${line}`);
                }

                if (action === 'remove') {
                    const match = vscode.debug.breakpoints.find(
                        (bp) =>
                            bp instanceof vscode.SourceBreakpoint &&
                            bp.location.uri.fsPath === fileUri.fsPath &&
                            bp.location.range.start.line === line - 1
                    );
                    if (!match) {
                        return text(`No breakpoint found at ${vscode.workspace.asRelativePath(fileUri)}:${line}.`);
                    }
                    vscode.debug.removeBreakpoints([match]);
                    return text(`Breakpoint removed: ${vscode.workspace.asRelativePath(fileUri)}:${line}`);
                }

                return text(`Unknown breakpoint action: "${action}". Use add, remove, list, or clear.`);
            }

            case 'debug_start': {
                const configName = args.name as string | undefined;
                const inlineConfig = args.config as vscode.DebugConfiguration | undefined;
                const folder = vscode.workspace.workspaceFolders?.[0];

                let started: boolean;
                if (inlineConfig) {
                    started = await vscode.debug.startDebugging(folder, inlineConfig);
                } else if (configName) {
                    started = await vscode.debug.startDebugging(folder, configName);
                } else {
                    // Launch default config
                    started = await vscode.debug.startDebugging(folder, undefined as unknown as string);
                }

                if (!started) {
                    return text('Failed to start debug session. Check that a valid launch configuration exists.');
                }
                // Brief wait for session to initialize
                await new Promise((r) => setTimeout(r, 500));
                const session = vscode.debug.activeDebugSession;
                return text(
                    `Debug session started: "${session?.name ?? 'unknown'}" (type: ${session?.type ?? 'unknown'})`
                );
            }

            case 'debug_stop': {
                const all = args.all as boolean | undefined;
                const clearBps = args.clear_breakpoints as boolean | undefined;
                if (all) {
                    await vscode.debug.stopDebugging(undefined);
                } else {
                    const session = vscode.debug.activeDebugSession;
                    if (!session) {
                        return text('No active debug session.');
                    }
                    await vscode.debug.stopDebugging(session);
                }
                let msg = all ? 'All debug sessions stopped.' : 'Debug session stopped.';
                if (clearBps) {
                    const bps = vscode.debug.breakpoints;
                    if (bps.length > 0) {
                        vscode.debug.removeBreakpoints(bps);
                        msg += ` Cleared ${bps.length} breakpoint(s).`;
                    }
                }
                return text(msg);
            }

            case 'debug_state': {
                const session = vscode.debug.activeDebugSession;
                if (!session) {
                    return text('No active debug session.');
                }
                const targetThreadId = args.thread_id as number | undefined;
                const maxDepth = (args.max_depth as number | undefined) ?? 1;

                const threadsResp = await session.customRequest('threads');
                const threads: Array<{ id: number; name: string }> = threadsResp.threads ?? [];
                if (threads.length === 0) {
                    return text('No threads available.');
                }

                const filtered = targetThreadId
                    ? threads.filter((t) => t.id === targetThreadId)
                    : threads;
                if (filtered.length === 0) {
                    return text(`Thread ${targetThreadId} not found. Available: ${threads.map((t) => t.id).join(', ')}`);
                }

                const output: string[] = [];
                for (const thread of filtered) {
                    let stackFrames: Array<{
                        id: number;
                        name: string;
                        source?: { name?: string; path?: string };
                        line: number;
                        column: number;
                    }> = [];
                    let stoppedReason = '';
                    try {
                        const stResp = await session.customRequest('stackTrace', {
                            threadId: thread.id,
                            startFrame: 0,
                            levels: 20,
                        });
                        stackFrames = stResp.stackFrames ?? [];
                    } catch {
                        stoppedReason = 'running';
                    }

                    output.push(
                        `Thread #${thread.id} "${thread.name}"${stoppedReason ? ` (${stoppedReason})` : ''}`
                    );

                    for (const frame of stackFrames) {
                        const src = frame.source?.path
                            ? vscode.workspace.asRelativePath(frame.source.path)
                            : frame.source?.name ?? '<unknown>';
                        output.push(`  Frame #${frame.id}: ${src}:${frame.line} in ${frame.name}`);

                        if (maxDepth < 1) continue;

                        try {
                            const scopesResp = await session.customRequest('scopes', { frameId: frame.id });
                            const scopes: Array<{ name: string; variablesReference: number; expensive: boolean }> =
                                scopesResp.scopes ?? [];

                            for (const scope of scopes) {
                                if (scope.expensive) {
                                    output.push(`    ${scope.name}: (expensive — skipped)`);
                                    continue;
                                }
                                output.push(`    ${scope.name}:`);
                                await this.expandVariables(session, scope.variablesReference, 1, maxDepth, 3, output);
                            }
                        } catch {
                            // scopes unavailable for this frame
                        }
                    }
                }

                return text(output.join('\n'));
            }

            case 'debug_control': {
                const session = vscode.debug.activeDebugSession;
                if (!session) {
                    return text('No active debug session.');
                }
                const action = args.action as string;

                if (action === 'evaluate') {
                    const expression = args.expression as string | undefined;
                    if (!expression) {
                        return text('Error: "expression" is required for evaluate.');
                    }
                    const evalArgs: Record<string, unknown> = {
                        expression,
                        context: (args.context as string) ?? 'repl',
                    };
                    if (args.frame_id !== undefined) {
                        evalArgs.frameId = args.frame_id;
                    }
                    const result = await session.customRequest('evaluate', evalArgs);
                    return text(result.result ?? '(no result)');
                }

                if (action === 'restart') {
                    await vscode.commands.executeCommand('workbench.action.debug.restart');
                    return text('Debug session restarting.');
                }

                // continue, pause, next, stepIn, stepOut — all require threadId
                let threadId = args.thread_id as number | undefined;
                if (threadId === undefined) {
                    const threadsResp = await session.customRequest('threads');
                    const threads: Array<{ id: number }> = threadsResp.threads ?? [];
                    if (threads.length === 0) {
                        return text('No threads available.');
                    }
                    threadId = threads[0].id;
                }

                try {
                    await session.customRequest(action, { threadId });
                } catch (e) {
                    return text(`"${action}" failed on thread ${threadId}: ${e}`);
                }
                return text(`"${action}" executed on thread ${threadId}.`);
            }

            case 'debug_console_output': {
                const lines = args.lines as number | undefined;
                const clear = args.clear as boolean | undefined;
                const output = this.readDebugOutput(lines);
                if (clear) this.clearDebugOutput();
                return text(output);
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
}
