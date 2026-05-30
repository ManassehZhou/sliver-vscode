import * as vscode from 'vscode';
import { Session, Beacon, Job } from '../grpc/clientpb/client';
import { ConnectionMeta } from '../storage/ConnectionStore';
import { ConnectionState } from '../client/SliverClient';

function osIcon(os: string, dead: boolean): vscode.ThemeIcon {
  if (dead) {
    return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  }
  const color = new vscode.ThemeColor('charts.green');
  switch (os.toLowerCase()) {
    case 'windows':
      return new vscode.ThemeIcon('vm', color);
    case 'darwin':
      return new vscode.ThemeIcon('device-desktop', color);
    default:
      return new vscode.ThemeIcon('terminal-linux', color);
  }
}

export class ConnectionNode extends vscode.TreeItem {
  constructor(
    readonly meta: ConnectionMeta,
    state: ConnectionState,
    isActive: boolean,
  ) {
    super(meta.operator, vscode.TreeItemCollapsibleState.None);
    this.id = meta.id;
    this.description = `${meta.lhost}:${meta.lport}${isActive ? '  ●' : ''}`;
    this.contextValue = state === 'connected' ? 'connection.connected' : 'connection.disconnected';
    this.tooltip = `${meta.operator} @ ${meta.lhost}:${meta.lport} — ${state}`;
    this.iconPath =
      state === 'connected'
        ? new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('charts.green'))
        : state === 'connecting'
          ? new vscode.ThemeIcon('loading~spin')
          : new vscode.ThemeIcon('vm-outline');
    if (state === 'disconnected') {
      this.command = { command: 'sliver.connection.connect', title: 'Connect', arguments: [this] };
    } else {
      this.command = { command: 'sliver.connection.activate', title: 'Activate', arguments: [this] };
    }
  }
}

export class SessionNode extends vscode.TreeItem {
  constructor(readonly session: Session) {
    super(session.Name || session.Hostname || session.ID.slice(0, 8), vscode.TreeItemCollapsibleState.None);
    this.id = session.ID;
    this.contextValue = 'session';
    this.description = `${session.Username}@${session.Hostname} · ${session.OS}/${session.Arch}`;
    this.iconPath = osIcon(session.OS, session.IsDead);
    this.tooltip = new vscode.MarkdownString(
      [
        `**${session.Name}** \`${session.ID}\``,
        '',
        `- Host: ${session.Hostname} (${session.RemoteAddress})`,
        `- User: ${session.Username}  ·  PID: ${session.PID}`,
        `- OS: ${session.OS}/${session.Arch}  ·  ${session.Transport}`,
        `- Implant: ${session.Filename}  v${session.Version}`,
      ].join('\n'),
    );
  }
}

export class BeaconNode extends vscode.TreeItem {
  constructor(readonly beacon: Beacon) {
    super(beacon.Name || beacon.Hostname || beacon.ID.slice(0, 8), vscode.TreeItemCollapsibleState.None);
    this.id = beacon.ID;
    this.contextValue = 'beacon';
    const pending = Number(beacon.TasksCount) - Number(beacon.TasksCountCompleted);
    this.description = `${beacon.Username}@${beacon.Hostname} · ${beacon.OS}/${beacon.Arch}${
      pending > 0 ? ` · ${pending} pending` : ''
    }`;
    this.iconPath = new vscode.ThemeIcon(
      beacon.IsDead ? 'circle-slash' : 'radio-tower',
      beacon.IsDead ? new vscode.ThemeColor('disabledForeground') : new vscode.ThemeColor('charts.blue'),
    );
    this.tooltip = new vscode.MarkdownString(
      [
        `**${beacon.Name}** \`${beacon.ID}\``,
        '',
        `- Host: ${beacon.Hostname} (${beacon.RemoteAddress})`,
        `- User: ${beacon.Username}  ·  PID: ${beacon.PID}`,
        `- OS: ${beacon.OS}/${beacon.Arch}  ·  ${beacon.Transport}`,
        `- Interval: ${Number(beacon.Interval) / 1e9}s  ·  Jitter: ${Number(beacon.Jitter) / 1e9}s`,
        `- Tasks: ${beacon.TasksCountCompleted}/${beacon.TasksCount} completed`,
      ].join('\n'),
    );
  }
}

export class JobNode extends vscode.TreeItem {
  constructor(readonly job: Job) {
    super(`${job.Name} (${job.Protocol}/${job.Port})`, vscode.TreeItemCollapsibleState.None);
    this.id = String(job.ID);
    this.contextValue = 'job';
    this.description = job.Description;
    this.iconPath = new vscode.ThemeIcon('broadcast', new vscode.ThemeColor('charts.orange'));
    this.tooltip = `Job ${job.ID}: ${job.Name} — ${job.Protocol} on port ${job.Port}${
      job.Domains.length ? ` (${job.Domains.join(', ')})` : ''
    }`;
  }
}

/** A placeholder row shown when a list is empty. */
export class MessageNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'message';
  }
}
