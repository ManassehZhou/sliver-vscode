import * as vscode from 'vscode';
import { OperatorConfig } from '../client/OperatorConfig';

const PREFIX = 'sliver.config.';

/**
 * Stores full operator configs (all sensitive) in OS-backed SecretStorage,
 * keyed by connection id.
 */
export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async save(id: string, config: OperatorConfig): Promise<void> {
    await this.secrets.store(PREFIX + id, JSON.stringify(config));
  }

  async load(id: string): Promise<OperatorConfig | undefined> {
    const raw = await this.secrets.get(PREFIX + id);
    return raw ? (JSON.parse(raw) as OperatorConfig) : undefined;
  }

  async delete(id: string): Promise<void> {
    await this.secrets.delete(PREFIX + id);
  }
}
