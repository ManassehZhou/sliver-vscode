import * as vscode from 'vscode';
import * as grpc from '@grpc/grpc-js';
import { SliverClient } from '../client/SliverClient';
import { Session } from '../grpc/clientpb/client';
import { TunnelData } from '../grpc/sliverpb/sliver';
import { log } from '../util/logger';

/**
 * Bridges a Sliver shell tunnel to a VSCode integrated terminal.
 *
 * Protocol (mirrors the official client's shell flow):
 *   1. CreateTunnel(sessionId)        -> server assigns a TunnelID
 *   2. open the TunnelData duplex stream
 *   3. send an empty TunnelData to bind the client to the tunnel
 *   4. Shell(ShellReq{TunnelID, EnablePTY, Rows, Cols, Request:{SessionID}})
 *   5. stream data <-> Pseudoterminal (gRPC delivers in order; no resequencing)
 */
class ShellPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose = this.closeEmitter.event;

  private stream?: grpc.ClientDuplexStream<TunnelData, TunnelData>;
  private tunnelId?: string;
  private closed = false;

  constructor(
    private readonly client: SliverClient,
    private readonly session: Session,
  ) {}

  async open(dims: vscode.TerminalDimensions | undefined): Promise<void> {
    const sessionId = this.session.ID;
    const enablePty = /linux|darwin/i.test(this.session.OS); // PTY only on *nix implants
    try {
      const tunnel = await this.client.createTunnel(sessionId);
      this.tunnelId = tunnel.TunnelID;

      this.stream = this.client.openTunnelData();
      this.stream.on('data', (td: TunnelData) => this.onTunnelData(td));
      this.stream.on('error', (err: Error) => this.fail(err.message));
      this.stream.on('end', () => this.shutdown());

      // Bind this client to the tunnel with an empty frame, then start the shell.
      this.send(Buffer.alloc(0));
      const shell = await this.client.shell({
        Path: '',
        EnablePTY: enablePty,
        Rows: dims?.rows ?? 0,
        Cols: dims?.columns ?? 0,
        TunnelID: this.tunnelId,
        Request: { SessionID: sessionId },
      });
      if (shell.Response?.Err) {
        this.fail(shell.Response.Err);
        return;
      }
      log.info(`Shell bound to tunnel ${this.tunnelId} (session ${sessionId})`);
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  private onTunnelData(td: TunnelData): void {
    if (td.TunnelID !== this.tunnelId) {
      return;
    }
    if (td.Closed) {
      this.shutdown();
      return;
    }
    if (td.Data && td.Data.length) {
      this.writeEmitter.fire(Buffer.from(td.Data).toString('utf8'));
    }
  }

  handleInput(data: string): void {
    if (!this.closed) {
      this.send(Buffer.from(data, 'utf8'));
    }
  }

  setDimensions(_dims: vscode.TerminalDimensions): void {
    // Initial size is sent in ShellReq; live PTY resize is not yet wired.
  }

  close(): void {
    this.shutdown();
  }

  private send(data: Buffer): void {
    if (!this.stream || !this.tunnelId) {
      return;
    }
    this.stream.write(
      TunnelData.fromPartial({
        TunnelID: this.tunnelId,
        SessionID: this.session.ID,
        Data: data,
      }),
    );
  }

  private fail(message: string): void {
    this.writeEmitter.fire(`\r\n\x1b[31mShell error: ${message}\x1b[0m\r\n`);
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.stream?.end();
      this.stream?.cancel();
    } catch {
      /* ignore */
    }
    if (this.tunnelId) {
      this.client.closeTunnel(this.tunnelId, this.session.ID).catch(() => undefined);
    }
    this.closeEmitter.fire();
  }
}

/** Open (or focus) an interactive shell terminal for a session. */
export function openShellTerminal(client: SliverClient, session: Session): void {
  const pty = new ShellPty(client, session);
  const terminal = vscode.window.createTerminal({
    name: `Sliver: ${session.Name || session.Hostname}`,
    pty,
  });
  terminal.show();
}
