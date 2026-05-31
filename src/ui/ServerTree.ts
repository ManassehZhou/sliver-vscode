import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';

type Category = 'operators' | 'builds' | 'profiles' | 'loot' | 'creds' | 'hosts' | 'websites' | 'canaries';

const CATEGORIES: { key: Category; label: string; icon: string; desc: string }[] = [
  { key: 'operators', label: 'Operators', icon: 'organization', desc: 'Red-team operators connected to this multiplayer server (read-only).' },
  { key: 'builds', label: 'Implant Builds', icon: 'file-binary', desc: 'Implants already compiled on this server. Re-download (regenerate) or delete them.' },
  { key: 'profiles', label: 'Profiles', icon: 'settings-gear', desc: 'Saved implant configurations. Generate a new implant from a profile, or delete it.' },
  { key: 'loot', label: 'Loot', icon: 'package', desc: 'Files/data captured during ops, stored server-side for the whole team. Add, download, delete.' },
  { key: 'creds', label: 'Credentials', icon: 'key', desc: 'Shared store of harvested usernames/passwords/hashes. Add or delete entries.' },
  { key: 'hosts', label: 'Hosts', icon: 'server', desc: 'Machines seen across sessions, with IOCs (files you dropped) for cleanup tracking. View details or delete.' },
  { key: 'websites', label: 'Websites', icon: 'globe', desc: 'Static content served by HTTP listeners (payload staging). Create sites, add content, delete.' },
  { key: 'canaries', label: 'Canaries', icon: 'bug', desc: 'DNS canary tokens embedded in implants — a lookup means the implant was detected (read-only).' },
];

export class CategoryNode extends vscode.TreeItem {
  constructor(readonly category: Category, label: string, icon: string, desc: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = `category.${category}`;
    this.tooltip = desc;
  }
}

export class ServerItemNode extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    contextValue: string,
    /** the value used by context-menu commands (name/id) */
    readonly value: string,
    /** the raw record, for commands that need more fields (e.g. copy username/password) */
    readonly data?: any,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = contextValue;
  }
}

type Node = CategoryNode | ServerItemNode;

/** Server-side data browser: operators, builds, profiles, loot, creds, hosts, websites, canaries. */
export class ServerTree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly connections: ConnectionManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    const client = this.connections.active;
    if (!client || client.state !== 'connected') {
      return element ? [] : [];
    }
    if (!element) {
      return CATEGORIES.map((c) => new CategoryNode(c.key, c.label, c.icon, c.desc));
    }
    if (!(element instanceof CategoryNode)) {
      return [];
    }
    try {
      switch (element.category) {
        case 'operators': {
          const r = await client.getOperators();
          return (r.Operators ?? []).map(
            (o: any) => new ServerItemNode(o.Name, o.Online ? '● online' : 'offline', 'operator', o.Name),
          );
        }
        case 'builds': {
          const r = await client.implantBuilds();
          return Object.entries(r.Configs ?? {}).map(
            ([name, cfg]: [string, any]) =>
              new ServerItemNode(name, `${cfg.GOOS}/${cfg.GOARCH}`, 'build', name),
          );
        }
        case 'profiles': {
          const r = await client.implantProfiles();
          return (r.Profiles ?? []).map(
            (p: any) => new ServerItemNode(p.Name, `${p.Config?.GOOS ?? ''}/${p.Config?.GOARCH ?? ''}`, 'profile', p.Name),
          );
        }
        case 'loot': {
          const r = await client.lootAll();
          return (r.Loot ?? []).map(
            (l: any) => new ServerItemNode(l.Name, `${l.Size ?? ''}B`, 'loot', l.ID),
          );
        }
        case 'creds': {
          const r = await client.creds();
          return (r.Credentials ?? []).map(
            (c: any) => new ServerItemNode(c.Username || '(no user)', c.Plaintext || c.Hash || '', 'cred', c.ID, c),
          );
        }
        case 'hosts': {
          const r = await client.hosts();
          return (r.Hosts ?? []).map(
            // Host.ID is empty server-side; HostUUID is the real identifier.
            (h: any) => new ServerItemNode(h.Hostname, h.OSVersion ?? '', 'host', h.HostUUID),
          );
        }
        case 'websites': {
          const r = await client.websites();
          return (r.Websites ?? []).map(
            (w: any) => new ServerItemNode(w.Name, `${Object.keys(w.Contents ?? {}).length} paths`, 'website', w.Name),
          );
        }
        case 'canaries': {
          const r = await client.canaries();
          return (r.Canaries ?? []).map(
            (c: any) => new ServerItemNode(c.Domain ?? c.ImplantName ?? '?', c.Triggered ? 'TRIGGERED' : 'untriggered', 'canary', c.Domain ?? ''),
          );
        }
        default:
          return [];
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A build/profile that's still being written returns "record not found"
      // transiently (e.g. an external builder mid-compile). It self-heals — tell
      // the operator to refresh rather than showing a dead-end error.
      const transient = /record not found|not found/i.test(msg);
      const node = new ServerItemNode(
        transient ? 'Loading… (a build is still compiling — Refresh)' : `Error: ${msg}`,
        '',
        'message',
        '',
      );
      node.iconPath = new vscode.ThemeIcon(transient ? 'loading~spin' : 'error');
      node.tooltip = msg;
      return [node];
    }
  }
}
