import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';
import { SessionNode, MessageNode } from './nodes';

type Node = SessionNode | MessageNode;

export class SessionsTree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly connections: ConnectionManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<Node[]> {
    const client = this.connections.active;
    if (!client || client.state !== 'connected') {
      return [new MessageNode('Not connected')];
    }
    try {
      const { Sessions } = await client.getSessions();
      if (Sessions.length === 0) {
        return [new MessageNode('No active sessions')];
      }
      return Sessions.map((s) => new SessionNode(s));
    } catch (err) {
      return [new MessageNode(`Error: ${(err as Error).message}`)];
    }
  }
}
