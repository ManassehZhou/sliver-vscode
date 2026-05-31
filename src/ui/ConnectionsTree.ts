import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';
import { ConnectionNode } from './nodes';

export class ConnectionsTree implements vscode.TreeDataProvider<ConnectionNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly connections: ConnectionManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConnectionNode): vscode.TreeItem {
    return element;
  }

  getChildren(): ConnectionNode[] {
    return this.connections
      .list()
      .map(
        (meta) =>
          new ConnectionNode(
            meta,
            this.connections.stateOf(meta.id),
            meta.id === this.connections.activeId,
          ),
      );
  }
}
