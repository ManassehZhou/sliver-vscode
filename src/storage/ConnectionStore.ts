import * as vscode from 'vscode';

/** Non-secret metadata about a saved connection, kept in globalState. */
export interface ConnectionMeta {
  id: string;
  operator: string;
  lhost: string;
  lport: number;
}

const KEY = 'sliver.connections';

/** Persists the list of saved connections (no secrets) in globalState. */
export class ConnectionStore {
  constructor(private readonly memento: vscode.Memento) {}

  list(): ConnectionMeta[] {
    return this.memento.get<ConnectionMeta[]>(KEY, []);
  }

  async add(meta: ConnectionMeta): Promise<void> {
    const all = this.list().filter((c) => c.id !== meta.id);
    all.push(meta);
    await this.memento.update(KEY, all);
  }

  async remove(id: string): Promise<void> {
    await this.memento.update(
      KEY,
      this.list().filter((c) => c.id !== id),
    );
  }
}
