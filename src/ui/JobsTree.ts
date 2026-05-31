import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';
import { JobNode, MessageNode } from './nodes';

type Node = JobNode | MessageNode;

export class JobsTree implements vscode.TreeDataProvider<Node> {
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
      const { Active } = await client.getJobs();
      if (Active.length === 0) {
        return [new MessageNode('No active jobs')];
      }
      return Active.map((j) => new JobNode(j));
    } catch (err) {
      return [new MessageNode(`Error: ${(err as Error).message}`)];
    }
  }
}
