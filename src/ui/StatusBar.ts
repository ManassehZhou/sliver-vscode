import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';

/** Status-bar indicator of the active connection state. */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly connections: ConnectionManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.update();
    this.item.show();
  }

  update(): void {
    const id = this.connections.activeId;
    const state = id ? this.connections.stateOf(id) : 'disconnected';
    const meta = this.connections.list().find((c) => c.id === id);
    switch (state) {
      case 'connected':
        this.item.text = `$(vm-active) Sliver: ${meta?.operator ?? 'connected'}`;
        this.item.tooltip = `Connected to ${id}`;
        this.item.command = 'sliver.connection.disconnect';
        break;
      case 'connecting':
        this.item.text = '$(loading~spin) Sliver: connecting…';
        this.item.command = undefined;
        break;
      default:
        this.item.text = '$(debug-disconnect) Sliver: offline';
        this.item.tooltip = 'Click to import or connect';
        this.item.command = 'sliver.connection.import';
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
