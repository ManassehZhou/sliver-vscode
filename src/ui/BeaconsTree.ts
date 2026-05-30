import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';
import { BeaconNode, MessageNode } from './nodes';

type Node = BeaconNode | MessageNode;

export class BeaconsTree implements vscode.TreeDataProvider<Node> {
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
      const { Beacons } = await client.getBeacons();
      if (Beacons.length === 0) {
        return [new MessageNode('No beacons')];
      }
      return Beacons.map((b) => new BeaconNode(b));
    } catch (err) {
      return [new MessageNode(`Error: ${(err as Error).message}`)];
    }
  }
}
