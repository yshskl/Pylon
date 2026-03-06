import * as vscode from 'vscode';
import { TerminalManager } from './terminalManager';
import { AgentServer } from './agentServer';
import { HubServer } from './hubServer';
import { SessionManager } from './sessionManager';

let terminalManager: TerminalManager | undefined;
let agentServer: AgentServer | undefined;
let hubServer: HubServer | undefined;
let sessionManager: SessionManager | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('pylon');
  const bufferLines: number = config.get('outputBufferLines', 2000);
  const autoStart: boolean = config.get('autoStart', true);
  const hubPort: number = config.get('port', 27681);

  const sessionId =
    vscode.workspace.workspaceFolders?.[0]?.name ?? 'default';

  terminalManager = new TerminalManager(bufferLines);
  agentServer = new AgentServer(terminalManager);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'pylon.showStatus';
  statusBarItem.text = '$(plug) Pylon';
  statusBarItem.tooltip = 'Pylon — click for status';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

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

    vscode.commands.registerCommand('pylon.showStatus', () => {
      const port = hubServer?.port ?? hubPort;
      const role = hubServer?.isRunning ? 'Hub' : 'Satellite';
      const info = hubServer?.isRunning
        ? `Running as Hub (session: "${sessionId}") on port ${port}`
        : `Running as Satellite (session: "${sessionId}") connected to hub on port ${port}`;

      if (agentServer?.isRunning) {
        vscode.window.showInformationMessage(
          `Pylon ${role}: ${info}`,
          'Copy MCP Config',
          'Stop'
        ).then((choice) => {
          if (choice === 'Copy MCP Config') {
            const cfg = buildMCPConfig(port);
            vscode.env.clipboard.writeText(JSON.stringify(cfg, null, 2));
            vscode.window.showInformationMessage('MCP config copied to clipboard!');
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

  context.subscriptions.push({
    dispose: () => {
      sessionManager?.dispose();
      hubServer?.stop();
      agentServer?.stop();
      terminalManager?.dispose();
    },
  });

  if (autoStart) {
    await startBridge(sessionId, bufferLines, hubPort);
  }
}

async function startBridge(sessionId: string, bufferLines: number, hubPort: number): Promise<void> {
  if (agentServer?.isRunning) {
    vscode.window.showWarningMessage('Pylon is already running.');
    return;
  }

  if (!terminalManager) {
    terminalManager = new TerminalManager(bufferLines);
  }
  if (!agentServer) {
    agentServer = new AgentServer(terminalManager);
  }

  try {
    await agentServer.start(27691);
  } catch (e) {
    vscode.window.showErrorMessage(`Pylon: failed to start agent server: ${e}`);
    return;
  }

  const agentUrl = `http://127.0.0.1:${agentServer.port}`;
  const hubExists = await SessionManager.discoverHub(hubPort);

  if (!hubExists) {
    // Become the hub
    hubServer = new HubServer(agentServer, sessionId, hubPort);
    try {
      await hubServer.start();
      updateStatusBar('hub', sessionId, hubPort);
      vscode.window.showInformationMessage(
        `Pylon: Hub started (session: "${sessionId}") on port ${hubPort}`,
        'Copy MCP Config'
      ).then((choice) => {
        if (choice === 'Copy MCP Config') {
          vscode.env.clipboard.writeText(JSON.stringify(buildMCPConfig(hubPort), null, 2));
          vscode.window.showInformationMessage('MCP config copied to clipboard!');
        }
      });
    } catch (e) {
      // Race condition — another window just became hub
      vscode.window.showWarningMessage(`Pylon: could not become hub (${e}), registering as satellite.`);
      await registerAsSatellite(sessionId, agentUrl, hubPort);
    }
  } else {
    await registerAsSatellite(sessionId, agentUrl, hubPort);
  }
}

async function registerAsSatellite(sessionId: string, agentUrl: string, hubPort: number): Promise<void> {
  sessionManager = new SessionManager(sessionId, agentUrl, async () => {
    // Hub lost — attempt to promote
    if (!agentServer || !terminalManager) return;
    hubServer = new HubServer(agentServer, sessionId, hubPort);
    try {
      await hubServer.start();
      updateStatusBar('hub', sessionId, hubPort);
      vscode.window.showInformationMessage(
        `Pylon: Promoted to Hub (session: "${sessionId}") on port ${hubPort}`
      );
    } catch {
      // Another satellite already promoted — re-register with new hub
      const retryDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 5; i++) {
        await retryDelay(500);
        if (await SessionManager.discoverHub(hubPort)) {
          try {
            await sessionManager!.registerWithHub(hubPort);
            sessionManager!.startHeartbeat(hubPort);
            updateStatusBar('satellite', sessionId, hubPort);
          } catch {
            // ignore — will retry on next iteration
          }
          return;
        }
      }
      vscode.window.showWarningMessage('Pylon: could not reconnect to hub after promotion race.');
    }
  });

  try {
    await sessionManager.registerWithHub(hubPort);
    sessionManager.startHeartbeat(hubPort);
    updateStatusBar('satellite', sessionId, hubPort);
    vscode.window.showInformationMessage(
      `Pylon: Connected as satellite (session: "${sessionId}")`
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Pylon: failed to register with hub: ${e}`);
  }
}

async function stopBridge(): Promise<void> {
  sessionManager?.dispose();
  sessionManager = undefined;
  await hubServer?.stop();
  hubServer = undefined;
  await agentServer?.stop();
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

export function deactivate(): void {
  sessionManager?.dispose();
  hubServer?.stop();
  agentServer?.stop();
  terminalManager?.dispose();
}
