import * as vscode from 'vscode';
import { SecretStore } from './storage/SecretStore';
import { ConnectionStore } from './storage/ConnectionStore';
import { ConnectionManager } from './client/ConnectionManager';
import { ConnectionsTree } from './ui/ConnectionsTree';
import { SessionsTree } from './ui/SessionsTree';
import { BeaconsTree } from './ui/BeaconsTree';
import { JobsTree } from './ui/JobsTree';
import { ServerTree } from './ui/ServerTree';
import { StatusBar } from './ui/StatusBar';
import { registerCommands } from './commands';
import { registerTier1 } from './commands/tier1';
import { registerTier2 } from './commands/tier2';
import { registerTier3 } from './commands/tier3';
import { registerExtended } from './commands/extended';
import { registerPivot, disposePortForwards } from './commands/pivot';
import { SliverFileSystemProvider, SLIVER_SCHEME } from './fs/SliverFileSystemProvider';
import { SESSION_EVENTS, BEACON_EVENTS, JOB_EVENTS, BUILD_EVENTS, EventType } from './client/events';
import { Event } from './grpc/clientpb/client';
import { log } from './util/logger';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager(
    new SecretStore(context.secrets),
    new ConnectionStore(context.globalState),
  );

  const connectionsTree = new ConnectionsTree(connections);
  const sessionsTree = new SessionsTree(connections);
  const beaconsTree = new BeaconsTree(connections);
  const jobsTree = new JobsTree(connections);
  const serverTree = new ServerTree(connections);
  const statusBar = new StatusBar(connections);

  context.subscriptions.push(
    connections,
    statusBar,
    vscode.workspace.registerFileSystemProvider(SLIVER_SCHEME, new SliverFileSystemProvider(connections)),
    vscode.window.createTreeView('sliverConnections', { treeDataProvider: connectionsTree }),
    vscode.window.createTreeView('sliverSessions', { treeDataProvider: sessionsTree }),
    vscode.window.createTreeView('sliverBeacons', { treeDataProvider: beaconsTree }),
    vscode.window.createTreeView('sliverJobs', { treeDataProvider: jobsTree }),
    vscode.window.createTreeView('sliverServer', { treeDataProvider: serverTree }),
  );

  const trees = {
    connections: connectionsTree,
    sessions: sessionsTree,
    beacons: beaconsTree,
    jobs: jobsTree,
  };

  const refreshData = () => {
    sessionsTree.refresh();
    beaconsTree.refresh();
    jobsTree.refresh();
    serverTree.refresh();
  };

  const updateConnectedContext = () => {
    const connected = connections.active?.state === 'connected';
    void vscode.commands.executeCommand('setContext', 'sliver.connected', connected);
  };

  // React to connection lifecycle.
  context.subscriptions.push(
    connections.onDidChangeActive(() => {
      connectionsTree.refresh();
      statusBar.update();
      updateConnectedContext();
      refreshData();
    }),
    connections.onDidChangeState(() => {
      connectionsTree.refresh();
      statusBar.update();
      updateConnectedContext();
      refreshData();
    }),
    // React to live server events, refreshing only the affected view.
    connections.onEvent((event: Event) => {
      if (SESSION_EVENTS.includes(event.EventType)) {
        sessionsTree.refresh();
      }
      if (BEACON_EVENTS.includes(event.EventType)) {
        beaconsTree.refresh();
      }
      if (JOB_EVENTS.includes(event.EventType)) {
        jobsTree.refresh();
      }
      if (BUILD_EVENTS.includes(event.EventType)) {
        serverTree.refresh();
      }
      // External builders report status on this stream; surface it instead of
      // letting a failed build silently vanish from the list.
      if (event.EventType === EventType.ExternalBuildFailed) {
        const [, reason] = splitBuildEventData(event.Data);
        void vscode.window.showErrorMessage(`External build failed: ${reason || 'unknown error'}`);
      }
      if (event.EventType === EventType.ExternalBuildCompleted) {
        const [, name] = splitBuildEventData(event.Data);
        void vscode.window.showInformationMessage(`External build completed${name ? `: ${name}` : ''}`);
      }
    }),
    ...registerCommands(connections, trees),
    ...registerTier1(connections),
    ...registerTier2(connections),
    ...registerTier3(connections, () => serverTree.refresh()),
    ...registerExtended(connections),
    ...registerPivot(connections),
  );

  updateConnectedContext();
  log.info('Sliver extension activated');
}

/** Split external-build event data ("buildID:details"); details may contain colons. */
function splitBuildEventData(data: Buffer | Uint8Array | undefined): [string, string] {
  const text = data ? Buffer.from(data).toString('utf8') : '';
  const sep = text.indexOf(':');
  return sep === -1 ? [text, ''] : [text.slice(0, sep), text.slice(sep + 1)];
}

export function deactivate(): void {
  disposePortForwards();
  log.dispose();
}
