import * as vscode from 'vscode';
import * as net from 'node:net';
import { ConnectionManager } from '../client/ConnectionManager';
import { SliverClient } from '../client/SliverClient';
import { TunnelData, SocksData } from '../grpc/sliverpb/sliver';
import { friendlyError, requireActive, resolveSession, showText, Node } from './helpers';
import { log } from '../util/logger';

/**
 * A local TCP port-forward: binds a local port and tunnels each connection
 * through the session to a remote host:port (one Sliver tunnel per connection).
 */
class PortForward {
  private server: net.Server;

  constructor(
    private readonly client: SliverClient,
    private readonly sessionId: string,
    readonly localPort: number,
    private readonly remoteHost: string,
    private readonly remotePort: number,
  ) {
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on('error', (err) => log.error('Port-forward server error', err));
    this.server.listen(localPort, '127.0.0.1');
  }

  private async onConnection(socket: net.Socket): Promise<void> {
    try {
      const tunnel = await this.client.createTunnel(this.sessionId);
      const tunnelId = tunnel.TunnelID;
      const stream = this.client.openTunnelData();
      const send = (data: Buffer) =>
        stream.write(TunnelData.fromPartial({ TunnelID: tunnelId, SessionID: this.sessionId, Data: data }));

      stream.on('data', (td: TunnelData) => {
        if (td.TunnelID !== tunnelId) {
          return;
        }
        if (td.Closed) {
          socket.end();
        } else if (td.Data?.length) {
          socket.write(Buffer.from(td.Data));
        }
      });
      stream.on('error', () => socket.destroy());
      stream.on('end', () => socket.end());

      send(Buffer.alloc(0)); // bind frame
      await this.client.portfwd({
        Host: this.remoteHost,
        Port: this.remotePort,
        Protocol: 0, // TCP
        TunnelID: tunnelId,
        Request: { SessionID: this.sessionId },
      });

      socket.on('data', (d) => send(d));
      socket.on('close', () => {
        try {
          stream.end();
          this.client.closeTunnel(tunnelId, this.sessionId).catch(() => undefined);
        } catch {
          /* ignore */
        }
      });
    } catch (err) {
      log.error('Port-forward connection failed', err);
      socket.destroy();
    }
  }

  dispose(): void {
    this.server.close();
  }
}

/**
 * A local SOCKS5 proxy. Each accepted TCP connection is a transparent byte pipe
 * to the implant (which performs the SOCKS5 negotiation), routed by TunnelID
 * over one shared SocksProxy stream — mirroring the official client.
 */
class SocksServer {
  private server: net.Server;
  private stream!: ReturnType<SliverClient['openSocksProxy']>;
  private pool = new Map<string, net.Socket>();
  readonly label: string;

  constructor(
    private readonly client: SliverClient,
    private readonly sessionId: string,
    readonly localPort: number,
    sessionName: string,
  ) {
    this.label = `socks5 127.0.0.1:${localPort} → ${sessionName}`;
    this.stream = this.client.openSocksProxy();
    this.stream.on('data', (sd: SocksData) => {
      const conn = this.pool.get(sd.TunnelID);
      if (!conn) {
        return;
      }
      if (sd.CloseConn) {
        conn.end();
        this.pool.delete(sd.TunnelID);
      } else if (sd.Data?.length) {
        conn.write(Buffer.from(sd.Data));
      }
    });
    this.stream.on('error', (e: Error) => log.warn(`socks stream: ${e.message}`));
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on('error', (e) => log.error('SOCKS server error', e));
    this.server.listen(localPort, '127.0.0.1');
  }

  private async onConnection(socket: net.Socket): Promise<void> {
    try {
      const socks = await this.client.createSocks({ SessionID: this.sessionId });
      const tunnelId = socks.TunnelID;
      this.pool.set(tunnelId, socket);
      let seq = 0;
      socket.on('data', (d) =>
        this.stream.write(
          SocksData.fromPartial({ Data: d, Sequence: String(seq++), TunnelID: tunnelId, Request: { SessionID: this.sessionId } }),
        ),
      );
      const close = () => {
        if (this.pool.delete(tunnelId)) {
          this.stream.write(SocksData.fromPartial({ CloseConn: true, TunnelID: tunnelId, Request: { SessionID: this.sessionId } }));
        }
      };
      socket.on('close', close);
      socket.on('error', close);
    } catch (e) {
      log.error('SOCKS connection failed', e);
      socket.destroy();
    }
  }

  dispose(): void {
    this.server.close();
    for (const s of this.pool.values()) {
      s.destroy();
    }
    this.pool.clear();
    try {
      this.stream.end();
    } catch {
      /* ignore */
    }
  }
}

const forwards: PortForward[] = [];
const socksServers: SocksServer[] = [];

export function disposePortForwards(): void {
  while (forwards.length) {
    forwards.pop()?.dispose();
  }
  while (socksServers.length) {
    socksServers.pop()?.dispose();
  }
}

export function registerPivot(connections: ConnectionManager): vscode.Disposable[] {
  const reg = (id: string, fn: (...a: any[]) => any) => vscode.commands.registerCommand(id, fn);

  return [
    reg('sliver.session.portfwd', async (node?: Node) => {
      const client = requireActive(connections);
      const s = client && (await resolveSession(connections, node));
      if (!client || !s) {
        return;
      }
      const localStr = await vscode.window.showInputBox({ prompt: 'Local bind port', value: '8080' });
      const local = Number(localStr);
      if (!Number.isInteger(local)) {
        return;
      }
      const remote = await vscode.window.showInputBox({ prompt: 'Remote target host:port', value: '127.0.0.1:3389' });
      if (!remote || !remote.includes(':')) {
        return;
      }
      const [host, portStr] = remote.split(':');
      try {
        forwards.push(new PortForward(client, s.ID, local, host, Number(portStr)));
        void vscode.window.showInformationMessage(`Port-forward: 127.0.0.1:${local} → ${remote} via ${s.Name}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`portfwd failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.rportfwd', async (node?: Node) => {
      const client = requireActive(connections);
      const s = client && (await resolveSession(connections, node));
      if (!client || !s) {
        return;
      }
      const bind = await vscode.window.showInputBox({ prompt: 'Implant-side bind host:port', value: '0.0.0.0:8080' });
      const fwd = bind && (await vscode.window.showInputBox({ prompt: 'Forward to (operator-side) host:port', value: '127.0.0.1:8080' }));
      if (!bind || !fwd || !bind.includes(':') || !fwd.includes(':')) {
        return;
      }
      const [ba, bp] = bind.split(':');
      const [fa, fp] = fwd.split(':');
      try {
        await client.startRportFwdListener({
          BindAddress: ba,
          BindPort: Number(bp),
          ForwardAddress: fa,
          ForwardPort: Number(fp),
          Request: { SessionID: s.ID },
        });
        void vscode.window.showInformationMessage(`Reverse port-forward: implant ${bind} → ${fwd}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`rportfwd failed: ${friendlyError(err)}`);
      }
    }),

    // --- SOCKS5 proxy ---------------------------------------------------
    reg('sliver.session.socks5', async (node?: Node) => {
      const client = requireActive(connections);
      const s = client && (await resolveSession(connections, node));
      if (!client || !s) {
        return;
      }
      const portStr = await vscode.window.showInputBox({ prompt: 'Local SOCKS5 bind port', value: '1080' });
      const port = Number(portStr);
      if (!Number.isInteger(port)) {
        return;
      }
      try {
        socksServers.push(new SocksServer(client, s.ID, port, s.Name || s.Hostname));
        void vscode.window.showInformationMessage(`SOCKS5 proxy on 127.0.0.1:${port} → ${s.Name}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`socks5 failed: ${friendlyError(err)}`);
      }
    }),

    // --- Pivot listeners (TCP / named-pipe) ----------------------------
    reg('sliver.session.pivotListener', async (node?: Node) => {
      const client = requireActive(connections);
      const s = client && (await resolveSession(connections, node));
      if (!client || !s) {
        return;
      }
      const type = await vscode.window.showQuickPick(['tcp', 'named-pipe'], { placeHolder: 'Pivot type' });
      if (!type) {
        return;
      }
      const bind = await vscode.window.showInputBox({
        prompt: type === 'tcp' ? 'Bind address (host:port)' : 'Pipe name',
        value: type === 'tcp' ? '0.0.0.0:9898' : 'sliver',
      });
      if (!bind) {
        return;
      }
      try {
        await client.pivotStartListener({ Type: type === 'tcp' ? 0 : 2, BindAddress: bind, Request: { SessionID: s.ID } });
        void vscode.window.showInformationMessage(`Pivot ${type} listener started on ${bind}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Pivot listener failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.pivotGraph', async () => {
      const client = requireActive(connections);
      if (!client) {
        return;
      }
      try {
        const g = await client.pivotGraph();
        await showText(JSON.stringify(g, null, 2), 'json');
      } catch (err) {
        void vscode.window.showErrorMessage(`Pivot graph failed: ${friendlyError(err)}`);
      }
    }),

    // --- WireGuard (WG implants only) ----------------------------------
    reg('sliver.session.wgPortfwd', async (node?: Node) => {
      const client = requireActive(connections);
      const s = client && (await resolveSession(connections, node));
      if (!client || !s) {
        return;
      }
      const localStr = await vscode.window.showInputBox({ prompt: 'WG local port', value: '8080' });
      const remote = (await vscode.window.showInputBox({ prompt: 'Remote address host:port', value: '127.0.0.1:3389' })) ?? '';
      if (!Number.isInteger(Number(localStr)) || !remote) {
        return;
      }
      try {
        await client.wgStartPortForward({ LocalPort: Number(localStr), RemoteAddress: remote, Request: { SessionID: s.ID } });
        void vscode.window.showInformationMessage(`WG port-forward ${localStr} → ${remote}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`WG portfwd failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.wgSocks', async (node?: Node) => {
      const client = requireActive(connections);
      const s = client && (await resolveSession(connections, node));
      if (!client || !s) {
        return;
      }
      const portStr = await vscode.window.showInputBox({ prompt: 'WG SOCKS port', value: '1081' });
      if (!Number.isInteger(Number(portStr))) {
        return;
      }
      try {
        await client.wgStartSocks({ Port: Number(portStr), Request: { SessionID: s.ID } });
        void vscode.window.showInformationMessage(`WG SOCKS on port ${portStr}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`WG socks failed: ${friendlyError(err)}`);
      }
    }),

    // --- List / stop active forwards & proxies -------------------------
    reg('sliver.pivot.list', async (node?: Node) => {
      const client = requireActive(connections);
      if (!client) {
        return;
      }
      const local = [
        ...forwards.map((f) => `[local portfwd]  127.0.0.1:${f.localPort}`),
        ...socksServers.map((sx) => `[socks5]        ${sx.label}`),
      ];
      let remote: string[] = [];
      const s = await resolveSession(connections, node);
      if (s) {
        try {
          const r = await client.getRportFwdListeners(s.ID);
          remote = (r.Listeners ?? []).map(
            (l: any) => `[rportfwd #${l.ID}]  implant ${l.BindAddress}:${l.BindPort} → ${l.ForwardAddress}:${l.ForwardPort}`,
          );
        } catch {
          /* ignore */
        }
      }
      await showText(['# Active forwards & proxies', '', ...local, ...remote].join('\n') || '(none)');
    }),

    reg('sliver.pivot.stopLocal', async () => {
      const items: { label: string; which: 'fwd' | 'socks'; i: number }[] = [
        ...forwards.map((f, i) => ({ label: `local portfwd 127.0.0.1:${f.localPort}`, which: 'fwd' as const, i })),
        ...socksServers.map((sx, i) => ({ label: sx.label, which: 'socks' as const, i })),
      ];
      if (!items.length) {
        void vscode.window.showInformationMessage('No active local forwards/proxies.');
        return;
      }
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Stop which?' });
      if (!pick) {
        return;
      }
      if (pick.which === 'fwd') {
        forwards.splice(pick.i, 1)[0]?.dispose();
      } else {
        socksServers.splice(pick.i, 1)[0]?.dispose();
      }
      void vscode.window.showInformationMessage('Stopped.');
    }),

    reg('sliver.session.rportfwdStop', async (node?: Node) => {
      const client = requireActive(connections);
      const s = client && (await resolveSession(connections, node));
      if (!client || !s) {
        return;
      }
      try {
        const r = await client.getRportFwdListeners(s.ID);
        const items: { label: string; id: number }[] = (r.Listeners ?? []).map((l: any) => ({
          label: `#${l.ID} ${l.BindAddress}:${l.BindPort}`,
          id: l.ID,
        }));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Stop which reverse port-forward?' });
        if (!pick) {
          return;
        }
        await client.stopRportFwdListener({ ID: pick.id, Request: { SessionID: s.ID } });
        void vscode.window.showInformationMessage('Reverse port-forward stopped.');
      } catch (err) {
        void vscode.window.showErrorMessage(`rportfwd stop failed: ${friendlyError(err)}`);
      }
    }),
  ];
}
