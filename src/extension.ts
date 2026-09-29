import * as vscode from 'vscode';
import { TerminalManager } from './terminalManager';
import { AgentServer } from './agentServer';
import { HubServer } from './hubServer';
import { SessionManager } from './sessionManager';
import { debounce } from './events';
import { sanitizeLabel } from './http';

let terminalManager: TerminalManager | undefined;
let agentServer: AgentServer | undefined;
let hubServer: HubServer | undefined;
let sessionManager: SessionManager | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
/** The port this activation is using — read once, so every path agrees on it. */
let activeHubPort = 27681;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('pylon');
  const bufferLines: number = config.get('outputBufferLines', 2000);
  const autoStart: boolean = config.get('autoStart', true);
  const hubPort: number = config.get('port', 27681);
  activeHubPort = hubPort;

  const sessionId = deriveSessionId();

  terminalManager = new TerminalManager(bufferLines);
  agentServer = new AgentServer(terminalManager, bufferLines);

  // Capture DAP output events (console.log, stderr, debugger messages)
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage(message: {
            type?: string;
            event?: string;
            body?: {
              output?: string;
              category?: string;
              reason?: string;
              threadId?: number;
              description?: string;
            };
          }) {
            if (message.type !== 'event') return;

            if (message.event === 'output' && message.body?.output) {
              if (message.body.category !== 'telemetry') {
                agentServer?.appendDebugOutput(message.body.output, message.body.category);
              }
              return;
            }

            // These were already arriving here and being thrown away. `stopped` in particular
            // carries the reason execution halted, which debug_state could never report — it
            // only ever saw the stack afterwards, so its stoppedReason was a placeholder.
            if (message.event === 'stopped') {
              const reason = message.body?.reason ?? 'unknown';
              agentServer?.setStoppedReason(session.id, reason);
              agentServer?.events.emit('debug.stopped', {
                reason,
                threadId: message.body?.threadId,
                description: message.body?.description,
              });
            } else if (message.event === 'continued') {
              agentServer?.setStoppedReason(session.id, null);
            } else if (message.event === 'terminated' || message.event === 'exited') {
              agentServer?.setStoppedReason(session.id, null);
              agentServer?.events.emit('debug.terminated', {});
            }
          },
        };
      },
    })
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'pylon.showStatus';
  statusBarItem.text = '$(plug) Pylon';
  statusBarItem.tooltip = 'Pylon — click for status';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Diagnostics fire on every keystroke, so this is debounced hard: subscribers re-read the
  // resource, they do not apply a delta, and one "something changed" per settle is enough.
  const emitDiagnostics = debounce((uris: readonly vscode.Uri[]) => {
    agentServer?.events.emit('diagnostics.changed', { files: uris.map((u) => u.fsPath).slice(0, 50) });
  }, 500);
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => emitDiagnostics(e.uris)),
    // debug.started rounds out the debug lifecycle: without it a subscriber to the debug
    // state resource learns about stops and exits but never about a session beginning.
    vscode.debug.onDidStartDebugSession((session) =>
      agentServer?.events.emit('debug.started', { name: session.name, type: session.type }),
    ),
    { dispose: () => emitDiagnostics.dispose() },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pylon.startMCP', async () => {
      await startBridge(sessionId, bufferLines, hubPort);
    }),

    vscode.commands.registerCommand('pylon.stopMCP', async () => {
      await stopBridge();
    }),

    vscode.commands.registerCommand('pylon.diagnose', () => {
      const terminals = vscode.window.terminals;
      if (terminals.length === 0) {
        vscode.window.showInformationMessage('No terminals open.');
        return;
      }
      const lines = terminals.map((t) => {
        const si = t.shellIntegration;
        const cwd = si?.cwd?.toString() ?? 'undefined';
        return `"${t.name}": shellIntegration=${si ? 'YES' : 'NO'}, cwd=${cwd}`;
      });
      vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
    }),

    vscode.commands.registerCommand('pylon.configureTools', async () => {
      const toolCategories: Record<string, string[]> = {
        'Terminal': [
          'terminal_list_sessions', 'terminal_list', 'terminal_run',
          'terminal_send_text', 'terminal_read_output', 'terminal_clear_buffer', 'terminal_wait',
        ],
        'IDE': [
          'get_diagnostics', 'get_document_symbols', 'get_references',
          'rename_symbol', 'run_command',
        ],
        'Editor': [
          'open_file', 'format_document', 'organize_imports', 'fix_all',
          'save_all', 'find_in_files', 'get_hover_info',
        ],
        'Debug': [
          'debug_breakpoints', 'debug_start', 'debug_stop',
          'debug_state', 'debug_control', 'debug_console_output',
        ],
      };

      const cfg = vscode.workspace.getConfiguration('pylon');
      const disabled = new Set(cfg.get<string[]>('disabledTools', []));

      const items: vscode.QuickPickItem[] = [];
      for (const [category, tools] of Object.entries(toolCategories)) {
        items.push({ label: category, kind: vscode.QuickPickItemKind.Separator });
        for (const tool of tools) {
          items.push({ label: tool, picked: !disabled.has(tool) });
        }
      }

      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'Pylon: Configure Tool Access',
        placeHolder: 'Uncheck tools to hide them from AI agents',
      });

      if (selected === undefined) return; // cancelled

      const allMenuTools = Object.values(toolCategories).flat();
      const selectedNames = new Set(selected.map((i) => i.label));
      // Preserve any manually-added disabled tool names not in the menu
      const otherDisabled = [...disabled].filter((t) => !allMenuTools.includes(t));
      const newlyDisabled = allMenuTools.filter((t) => !selectedNames.has(t));
      const finalDisabled = [...otherDisabled, ...newlyDisabled];

      await cfg.update('disabledTools', finalDisabled.length > 0 ? finalDisabled : undefined, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        finalDisabled.length > 0
          ? `Pylon: ${finalDisabled.length} tool(s) disabled. Changes take effect on next agent request.`
          : 'Pylon: All tools enabled.'
      );
    }),

    vscode.commands.registerCommand('pylon.showStatus', () => {
      const port = hubServer?.port ?? hubPort;
      const role = hubServer?.isRunning ? 'Hub' : 'Satellite';
      // Use the id actually registered, not the pre-disambiguation one this closure captured at
      // activation — a name collision can have the hub assign a different one.
      const effectiveId = hubServer?.isRunning
        ? (hubServer?.sessionId ?? sessionId)
        : (sessionManager?.effectiveSessionId ?? sessionId);
      const info = hubServer?.isRunning
        ? `Running as Hub (session: "${effectiveId}") on port ${port}`
        : `Running as Satellite (session: "${effectiveId}") connected to hub on port ${port}`;

      if (agentServer?.isRunning) {
        vscode.window.showInformationMessage(
          `Pylon ${role}: ${info}`,
          'Copy MCP Config',
          'Configure Tools',
          'Stop'
        ).then((choice) => {
          if (choice === 'Copy MCP Config') {
            const cfg = buildMCPConfig(port);
            vscode.env.clipboard.writeText(JSON.stringify(cfg, null, 2));
            vscode.window.showInformationMessage('MCP config copied to clipboard!');
          } else if (choice === 'Configure Tools') {
            vscode.commands.executeCommand('pylon.configureTools');
          } else if (choice === 'Stop') {
            vscode.commands.executeCommand('pylon.stopMCP');
          }
        });
      } else {
        vscode.window.showInformationMessage(
          'Pylon is not running.',
          'Start'
        ).then((choice) => {
          if (choice === 'Start') {
            vscode.commands.executeCommand('pylon.startMCP');
          }
        });
      }
    })
  );

  // Teardown lives in deactivate(), which VS Code awaits. A second, un-awaited copy here
  // would race it: whichever ran first would null the server and turn the other into a no-op,
  // with the shutdown still in flight.

  if (autoStart) {
    await startBridge(sessionId, bufferLines, hubPort);
  }
}

/**
 * The id this window registers under.
 *
 * Sanitized here, once, so the hub's own entry and the value a satellite sends are identical.
 * Doing it in two places meant a folder named `My  App` became `My App` when that window was
 * hub and stayed `My  App` when it was a satellite — two keys for one window.
 */
function deriveSessionId(): string {
  return sanitizeLabel(vscode.workspace.workspaceFolders?.[0]?.name ?? 'default');
}

/**
 * Try to start this window as the hub on `hubPort`.
 *
 * Shared by all three "become hub" call sites (fresh start, promotion after losing a hub, and
 * recovery of an orphaned window) so the HubServer construction, the status bar update and the
 * hubServer/undefined bookkeeping on failure live in exactly one place. Each caller still owns
 * its own user-facing messaging, since that differs (a toast with a button, a warning that
 * includes the error, a plain "promoted" notice).
 */
async function tryBecomeHub(
  sessionId: string,
  hubPort: number,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  if (!agentServer) return { ok: false, error: new Error('agent server not running') };
  hubServer = new HubServer(agentServer, sessionId, hubPort);
  try {
    await hubServer.start();
    updateStatusBar('hub', sessionId, hubPort);
    return { ok: true };
  } catch (error) {
    // Leave no half-started hub behind: the instance never listened, but its constructor
    // already subscribed to ownAgent.events (unconditionally, unlike the sweepTimer) — without
    // stop(), that subscription would outlive this discarded instance and keep re-emitting into
    // an event bus nobody reads.
    await hubServer.stop();
    hubServer = undefined;
    return { ok: false, error };
  }
}

async function startBridge(sessionId: string, bufferLines: number, hubPort: number): Promise<void> {
  // A window whose agent server is up but which belongs to no hub is exactly the state a
  // failed promotion leaves behind. Refusing to act on it made the command useless for the
  // one situation where the user most needs it, so recover instead of reporting success.
  if (agentServer?.isRunning && (hubServer?.isRunning || sessionManager)) {
    vscode.window.showWarningMessage('Pylon is already running.');
    return;
  }
  if (agentServer?.isRunning) {
    sessionManager?.dispose();
    sessionManager = undefined;
    const agentUrl = `http://127.0.0.1:${agentServer.port}`;
    const hubExists = await SessionManager.discoverHub(hubPort);
    if (hubExists) { await registerAsSatellite(sessionId, agentUrl, hubPort); return; }
    // Another window just took the port — that is the ordinary outcome of a race, not a
    // failure. Join it instead of leaving this window orphaned again.
    const result = await tryBecomeHub(sessionId, hubPort);
    if (result.ok) {
      vscode.window.showInformationMessage(`Pylon: Hub started (session: "${sessionId}")`);
    } else {
      await registerAsSatellite(sessionId, agentUrl, hubPort);
    }
    return;
  }

  if (!terminalManager) {
    terminalManager = new TerminalManager(bufferLines);
  }
  if (!agentServer) {
    agentServer = new AgentServer(terminalManager, bufferLines);
  }

  try {
    // Derived from the hub port so moving one moves the other; they were independent
    // before, which made pylon.port only half-configurable.
    await agentServer.start(hubPort + 10);
  } catch (e) {
    vscode.window.showErrorMessage(`Pylon: failed to start agent server: ${e}`);
    return;
  }

  const agentUrl = `http://127.0.0.1:${agentServer.port}`;
  const hubExists = await SessionManager.discoverHub(hubPort);

  if (!hubExists) {
    const result = await tryBecomeHub(sessionId, hubPort);
    if (result.ok) {
      vscode.window.showInformationMessage(
        `Pylon: Hub started (session: "${sessionId}") on port ${hubPort}`,
        'Copy MCP Config'
      ).then((choice) => {
        if (choice === 'Copy MCP Config') {
          vscode.env.clipboard.writeText(JSON.stringify(buildMCPConfig(hubPort), null, 2));
          vscode.window.showInformationMessage('MCP config copied to clipboard!');
        }
      });
    } else {
      // Race condition — another window just became hub
      vscode.window.showWarningMessage(`Pylon: could not become hub (${result.error}), registering as satellite.`);
      await registerAsSatellite(sessionId, agentUrl, hubPort);
    }
  } else {
    await registerAsSatellite(sessionId, agentUrl, hubPort);
  }
}

async function registerAsSatellite(sessionId: string, agentUrl: string, hubPort: number): Promise<void> {
  // Declared before assignment and captured by identity in the callback below: onHubLost is
  // async and can still be mid-flight (its own retry loop runs for up to ~25s) after something
  // else — a manual stop, a fresh registerAsSatellite call — has replaced the module-level
  // `sessionManager` with a newer instance. Reading `sessionManager` by name at that point would
  // silently act on that newer instance instead of being a no-op for this dead one.
  const mine: SessionManager = new SessionManager(sessionId, agentUrl, async () => {
    // Hub lost — attempt to promote. Read back the id this window actually registered under:
    // the hub may have assigned a different one on a name collision, and promoting under the
    // originally-requested id would hand the new hub's registry a name no satellite recognizes.
    if (!agentServer || !terminalManager) return;
    if (sessionManager !== mine) return;
    const effectiveId = mine.effectiveSessionId;
    const result = await tryBecomeHub(effectiveId, hubPort);
    if (sessionManager !== mine) return;
    if (result.ok) {
      vscode.window.showInformationMessage(
        `Pylon: Promoted to Hub (session: "${effectiveId}") on port ${hubPort}`
      );
    } else {
      // Another satellite won the race for the port — re-register with whoever holds it.
      const retryDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // Exponential backoff over ~25s instead of five fixed 500ms tries. The old loop also
      // returned from inside the catch, so a failed registration was never retried despite a
      // comment promising it was — that window stayed orphaned with a green status bar.
      for (let attempt = 0; attempt < 8; attempt++) {
        await retryDelay(Math.min(500 * 2 ** attempt, 8000));
        if (sessionManager !== mine) return;
        if (!(await SessionManager.discoverHub(hubPort))) continue;
        try {
          await mine.registerWithHub(hubPort);
          if (sessionManager !== mine) return;
          mine.startHeartbeat(hubPort);
          updateStatusBar('satellite', mine.effectiveSessionId, hubPort);
          return;
        } catch {
          // Genuinely retried now: the hub may still be finishing its own startup.
        }
      }
      if (sessionManager !== mine) return;
      // Cleared so the recovery path in startBridge is actually reachable: while this is set,
      // the "already running" guard turns the command the message recommends into a no-op.
      mine.dispose();
      sessionManager = undefined;
      updateStatusBar('stopped', '');
      vscode.window.showWarningMessage(
        'Pylon: could not reconnect to a hub. Run "Pylon: Start MCP Server" to retry.'
      );
    }
  });
  sessionManager = mine;

  try {
    await mine.registerWithHub(hubPort);
    mine.startHeartbeat(hubPort);
    const effectiveId = mine.effectiveSessionId;
    updateStatusBar('satellite', effectiveId, hubPort);
    vscode.window.showInformationMessage(
      `Pylon: Connected as satellite (session: "${effectiveId}")`
    );
  } catch (e) {
    // Same reason as above — leaving a SessionManager behind that never heartbeats would
    // block the manual retry without ever triggering failover on its own.
    mine.dispose();
    if (sessionManager === mine) sessionManager = undefined;
    updateStatusBar('stopped', '');
    vscode.window.showErrorMessage(`Pylon: failed to register with hub: ${e}`);
  }
}

async function stopBridge(): Promise<void> {
  await sessionManager?.unregister(activeHubPort);
  sessionManager?.dispose();
  sessionManager = undefined;
  // The two servers share no state during teardown, so stopping them in parallel halves the
  // wait instead of paying each one's shutdown grace period back to back.
  await Promise.all([hubServer?.stop(), agentServer?.stop()]);
  hubServer = undefined;
  agentServer = undefined;
  updateStatusBar('stopped', '');
  vscode.window.showInformationMessage('Pylon stopped.');
}

function updateStatusBar(role: 'hub' | 'satellite' | 'stopped', sessionId: string, port?: number): void {
  if (!statusBarItem) return;
  if (role === 'hub') {
    statusBarItem.text = `$(plug) Pylon Hub: ${sessionId}`;
    statusBarItem.tooltip = `Pylon Hub — session "${sessionId}" on port ${port}`;
    statusBarItem.backgroundColor = undefined;
  } else if (role === 'satellite') {
    statusBarItem.text = `$(circle-outline) Pylon: ${sessionId}`;
    statusBarItem.tooltip = `Pylon Satellite — session "${sessionId}" connected to hub on port ${port}`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(circle-slash) Pylon`;
    statusBarItem.tooltip = 'Pylon stopped — click to start';
  }
}

function buildMCPConfig(port: number): object {
  return {
    mcpServers: {
      'pylon': {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
      },
    },
  };
}

export async function deactivate(): Promise<void> {
  // Closing a window is how a satellite usually disappears — far more common than the manual
  // Stop command — so this is the path that most needs to say goodbye.
  await sessionManager?.unregister(activeHubPort);
  sessionManager?.dispose();
  // Awaited, not fired and forgotten: VS Code gives deactivate a chance to finish, and the
  // servers now hold sockets that must be released before the ports are free again. Run in
  // parallel — the two share no teardown state — so a slow one doesn't double the wait.
  await Promise.all([hubServer?.stop(), agentServer?.stop()]);
  terminalManager?.dispose();
}
