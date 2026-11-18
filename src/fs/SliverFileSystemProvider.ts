import * as vscode from 'vscode';
import * as zlib from 'node:zlib';
import * as path from 'node:path';
import { ConnectionManager } from '../client/ConnectionManager';

export const SLIVER_SCHEME = 'sliver';

/** Build a sliver:// URI for a session's remote path. */
export function sliverUri(sessionId: string, remotePath = '/'): vscode.Uri {
  return vscode.Uri.from({ scheme: SLIVER_SCHEME, authority: sessionId, path: remotePath });
}

/**
 * Exposes a session's remote filesystem to the VSCode Explorer via the
 * `sliver://<sessionId>/<path>` scheme. Maps native FS operations to the Sliver
 * Ls/Download/Upload/Mkdir/Rm/Mv RPCs. Sessions only (beacons are async).
 */
export class SliverFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;

  constructor(private readonly connections: ConnectionManager) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  private client() {
    const c = this.connections.active;
    if (!c || c.state !== 'connected') {
      throw vscode.FileSystemError.Unavailable('Sliver: not connected');
    }
    return c;
  }

  private decode(data: Buffer, encoder: string): Uint8Array {
    return /gzip/i.test(encoder) ? zlib.gunzipSync(data) : new Uint8Array(data);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const p = uri.path || '/';
    if (p === '/' || p === '') {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    // Stat by listing the parent and finding the entry — gives type + size.
    const parent = path.posix.dirname(p);
    const base = path.posix.basename(p);
    const ls = await this.client().ls({ Path: parent, Request: { SessionID: uri.authority } });
    const entry = ls.Files.find((f: any) => f.Name === base);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const mtime = Number(entry.ModTime) * 1000 || 0;
    return {
      type: entry.IsDir ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: mtime,
      mtime,
      size: Number(entry.Size) || 0,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const ls = await this.client().ls({ Path: uri.path || '/', Request: { SessionID: uri.authority } });
    if (!ls.Exists) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return ls.Files.filter((f: any) => f.Name !== '.' && f.Name !== '..').map((f: any) => [
      f.Name,
      f.IsDir ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const dl = await this.client().download({ Path: uri.path, Request: { SessionID: uri.authority, Timeout: '60' } });
    if (!dl.Exists) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return this.decode(Buffer.from(dl.Data), dl.Encoder);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const gz = zlib.gzipSync(Buffer.from(content));
    await this.client().upload({
      Path: uri.path,
      Data: gz,
      Encoder: 'gzip',
      Overwrite: true,
      Request: { SessionID: uri.authority, Timeout: '60' },
    });
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.client().mkdir({ Path: uri.path, Request: { SessionID: uri.authority } });
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.client().rm({
      Path: uri.path,
      Recursive: options.recursive,
      Force: true,
      Request: { SessionID: uri.authority },
    });
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    await this.client().mv({ Src: oldUri.path, Dst: newUri.path, Request: { SessionID: oldUri.authority } });
  }
}
