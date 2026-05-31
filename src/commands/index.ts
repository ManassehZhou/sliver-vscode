import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';
import { SliverClient } from '../client/SliverClient';
import { parseOperatorConfig, ConfigParseError } from '../client/OperatorConfig';
import { Session } from '../grpc/clientpb/client';
import { ConnectionNode, SessionNode, BeaconNode, JobNode } from '../ui/nodes';
import { ConsolePanel } from '../webview/ConsolePanel';
import { GeneratePanel } from '../webview/GeneratePanel';
import { ListenerPanel } from '../webview/ListenerPanel';
import { RawRpcPanel } from '../webview/RawRpcPanel';
import { openShellTerminal } from '../terminal/ShellTerminal';
import { log } from '../util/logger';

export interface Trees {
  connections: { refresh(): void };
  sessions: { refresh(): void };
  beacons: { refresh(): void };
  jobs: { refresh(): void };
}

/** Registers every command and returns disposables for context.subscriptions. */
export function registerCommands(
  connections: ConnectionManager,
  trees: Trees,
): vscode.Disposable[] {
  const reg = (id: string, fn: (...args: any[]) => any) => vscode.commands.registerCommand(id, fn);

  const requireActive = (): SliverClient | undefined => {
    const client = connections.active;
    if (!client || client.state !== 'connected') {
      void vscode.window.showWarningMessage('Sliver: not connected.');
      return undefined;
    }
    return client;
  };

  const showText = async (content: string, language = 'log') => {
    const doc = await vscode.workspace.openTextDocument({ content, language });
    await vscode.window.showTextDocument(doc, { preview: true });
  };

  const pickSession = async (): Promise<Session | undefined> => {
    const client = requireActive();
    if (!client) {
      return undefined;
    }
    const { Sessions } = await client.getSessions();
    const live = Sessions.filter((s) => !s.IsDead);
    if (live.length === 0) {
      void vscode.window.showInformationMessage('No active sessions.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      live.map((s) => ({ label: s.Name, description: `${s.Username}@${s.Hostname}`, session: s })),
      { placeHolder: 'Select a session' },
    );
    return pick?.session;
  };

  return [
    // --- Connections ----------------------------------------------------
    reg('sliver.connection.import', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Operator config': ['cfg', 'json'], 'All files': ['*'] },
        openLabel: 'Import',
      });
      if (!uris?.length) {
        return;
      }
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uris[0])).toString('utf8');
        const config = parseOperatorConfig(raw);
        const id = await connections.import(config);
        trees.connections.refresh();
        const choice = await vscode.window.showInformationMessage(
          `Imported "${id}". Connect now?`,
          'Connect',
        );
        if (choice === 'Connect') {
          await vscode.commands.executeCommand('sliver.connection.connect', { meta: { id } });
        }
      } catch (err) {
        const msg = err instanceof ConfigParseError ? err.message : (err as Error).message;
        void vscode.window.showErrorMessage(`Invalid operator config: ${msg}`);
      }
    }),

    reg('sliver.connection.connect', async (node?: ConnectionNode | { meta: { id: string } }) => {
      const id = node?.meta?.id ?? connections.list()[0]?.id;
      if (!id) {
        return;
      }
      trees.connections.refresh();
      try {
        await connections.connect(id);
      } catch (err) {
        void vscode.window.showErrorMessage(`Connect failed: ${(err as Error).message}`);
        log.error('Connect failed', err);
      }
      trees.connections.refresh();
    }),

    reg('sliver.connection.disconnect', (node?: ConnectionNode) => {
      const id = node?.meta?.id ?? connections.activeId;
      if (id) {
        connections.disconnect(id);
        trees.connections.refresh();
      }
    }),

    reg('sliver.connection.activate', (node?: ConnectionNode) => {
      if (node?.meta?.id) {
        connections.setActive(node.meta.id);
        trees.connections.refresh();
      }
    }),

    reg('sliver.connection.remove', async (node?: ConnectionNode) => {
      const id = node?.meta?.id;
      if (!id) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Remove connection "${id}"? Stored credentials will be deleted.`,
        { modal: true },
        'Remove',
      );
      if (ok === 'Remove') {
        await connections.remove(id);
        trees.connections.refresh();
      }
    }),

    reg('sliver.refresh', () => {
      trees.sessions.refresh();
      trees.beacons.refresh();
      trees.jobs.refresh();
    }),

    // --- Sessions -------------------------------------------------------
    reg('sliver.session.execute', async (node?: SessionNode) => {
      const client = requireActive();
      if (!client) {
        return;
      }
      const session = node?.session ?? (await pickSession());
      if (session) {
        ConsolePanel.open(client, session.ID, session.Name || session.Hostname);
      }
    }),

    reg('sliver.session.shell', async (node?: SessionNode) => {
      const client = requireActive();
      if (!client) {
        return;
      }
      const session = node?.session ?? (await pickSession());
      if (session) {
        openShellTerminal(client, session);
      }
    }),

    reg('sliver.session.ps', async (node?: SessionNode) => {
      const client = requireActive();
      if (!client || !node?.session) {
        return;
      }
      try {
        const ps = await client.ps({ Request: { SessionID: node.session.ID } });
        const lines = ps.Processes.map(
          (p) => `${String(p.Pid).padStart(7)}  ${String(p.Ppid).padStart(7)}  ${p.Owner ?? ''}  ${p.Executable}`,
        );
        await showText([`PID      PPID     OWNER  EXECUTABLE`, ...lines].join('\n'));
      } catch (err) {
        void vscode.window.showErrorMessage(`ps failed: ${(err as Error).message}`);
      }
    }),

    reg('sliver.session.info', async (node?: SessionNode) => {
      if (node?.session) {
        await showText(JSON.stringify(node.session, null, 2), 'json');
      }
    }),

    reg('sliver.session.kill', async (node?: SessionNode) => {
      const client = requireActive();
      if (!client || !node?.session) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Kill session ${node.session.Name}?`,
        { modal: true },
        'Kill',
      );
      if (ok === 'Kill') {
        try {
          await client.killSession(node.session.ID);
          trees.sessions.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(`Kill failed: ${(err as Error).message}`);
        }
      }
    }),

    // --- Beacons --------------------------------------------------------
    reg('sliver.beacon.execute', async (node?: BeaconNode) => {
      const client = requireActive();
      if (!client || !node?.beacon) {
        return;
      }
      const line = await vscode.window.showInputBox({ prompt: 'Command to queue (e.g. whoami)' });
      if (!line) {
        return;
      }
      const argv = line.trim().split(/\s+/);
      try {
        await client.execute({
          Path: argv[0],
          Args: argv.slice(1),
          Output: true,
          Request: { BeaconID: node.beacon.ID, Async: true },
        });
        void vscode.window.showInformationMessage('Task queued; results arrive on next check-in.');
        trees.beacons.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(`Queue failed: ${(err as Error).message}`);
      }
    }),

    reg('sliver.beacon.tasks', async (node?: BeaconNode) => {
      const client = requireActive();
      if (!client || !node?.beacon) {
        return;
      }
      try {
        const { Tasks } = await client.getBeaconTasks(node.beacon.ID);
        const lines = Tasks.map(
          (t) => `${t.State.padEnd(10)} ${t.Description.padEnd(20)} created=${t.CreatedAt} id=${t.ID}`,
        );
        await showText(lines.join('\n') || '(no tasks)');
      } catch (err) {
        void vscode.window.showErrorMessage(`tasks failed: ${(err as Error).message}`);
      }
    }),

    reg('sliver.beacon.info', async (node?: BeaconNode) => {
      if (node?.beacon) {
        await showText(JSON.stringify(node.beacon, null, 2), 'json');
      }
    }),

    // --- Jobs / listeners ----------------------------------------------
    reg('sliver.job.kill', async (node?: JobNode) => {
      const client = requireActive();
      if (!client || !node?.job) {
        return;
      }
      try {
        await client.killJob(node.job.ID);
        trees.jobs.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(`Stop job failed: ${(err as Error).message}`);
      }
    }),

    reg('sliver.listener.start', () => {
      const client = requireActive();
      if (client) {
        ListenerPanel.open(client);
      }
    }),

    reg('sliver.implant.generate', () => {
      const client = requireActive();
      if (client) {
        GeneratePanel.open(client);
      }
    }),

    reg('sliver.server.rawRpc', () => {
      const client = requireActive();
      if (client) {
        RawRpcPanel.open(client);
      }
    }),
  ];
}
