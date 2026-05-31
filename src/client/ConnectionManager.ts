import * as vscode from 'vscode';
import { SliverClient, ConnectionState } from './SliverClient';
import { OperatorConfig, connectionId } from './OperatorConfig';
import { Event } from '../grpc/clientpb/client';
import { SecretStore } from '../storage/SecretStore';
import { ConnectionStore, ConnectionMeta } from '../storage/ConnectionStore';
import { log } from '../util/logger';

/**
 * Owns all SliverClient instances, tracks which one is active, and re-exposes
 * the active client's events + state changes as VSCode events the UI binds to.
 */
export class ConnectionManager implements vscode.Disposable {
  private clients = new Map<string, SliverClient>();
  private _activeId?: string;

  private readonly _onDidChangeActive = new vscode.EventEmitter<SliverClient | undefined>();
  readonly onDidChangeActive = this._onDidChangeActive.event;

  private readonly _onDidChangeState = new vscode.EventEmitter<ConnectionState>();
  readonly onDidChangeState = this._onDidChangeState.event;

  private readonly _onEvent = new vscode.EventEmitter<Event>();
  /** Server events from the active connection. */
  readonly onEvent = this._onEvent.event;

  constructor(
    readonly secrets: SecretStore,
    readonly store: ConnectionStore,
  ) {}

  list(): ConnectionMeta[] {
    return this.store.list();
  }

  get active(): SliverClient | undefined {
    return this._activeId ? this.clients.get(this._activeId) : undefined;
  }

  get activeId(): string | undefined {
    return this._activeId;
  }

  isConnected(id: string): boolean {
    return this.clients.get(id)?.state === 'connected';
  }

  stateOf(id: string): ConnectionState {
    return this.clients.get(id)?.state ?? 'disconnected';
  }

  /** Import & persist a config; does not connect. Returns its connection id. */
  async import(config: OperatorConfig): Promise<string> {
    const id = connectionId(config);
    await this.secrets.save(id, config);
    await this.store.add({ id, operator: config.operator, lhost: config.lhost, lport: config.lport });
    return id;
  }

  async connect(id: string): Promise<void> {
    let client = this.clients.get(id);
    if (!client) {
      const config = await this.secrets.load(id);
      if (!config) {
        throw new Error(`No stored config for ${id}`);
      }
      client = new SliverClient(config);
      client.on('state', (state: ConnectionState) => {
        if (id === this._activeId) {
          this._onDidChangeState.fire(state);
        }
      });
      client.on('event', (event: Event) => {
        if (id === this._activeId) {
          this._onEvent.fire(event);
        }
      });
      client.on('error', (err: Error) => log.error('Connection error', err));
      this.clients.set(id, client);
    }
    await client.connect();
    this.setActive(id);
  }

  disconnect(id: string): void {
    this.clients.get(id)?.disconnect();
    if (id === this._activeId) {
      this._onDidChangeState.fire('disconnected');
    }
  }

  async remove(id: string): Promise<void> {
    this.clients.get(id)?.dispose();
    this.clients.delete(id);
    await this.secrets.delete(id);
    await this.store.remove(id);
    if (id === this._activeId) {
      this.setActive(undefined);
    }
  }

  setActive(id: string | undefined): void {
    this._activeId = id;
    this._onDidChangeActive.fire(this.active);
    this._onDidChangeState.fire(this.stateOf(id ?? ''));
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
    this._onDidChangeActive.dispose();
    this._onDidChangeState.dispose();
    this._onEvent.dispose();
  }
}
