import * as vscode from 'vscode';
import { SliverClient } from '../client/SliverClient';
import { getNonce, cspMeta } from './webviewUtil';

interface ListenerForm {
  type: 'mtls' | 'http' | 'https' | 'dns' | 'wg' | 'stager';
  host: string;
  port: number;
  // http/https
  domain: string;
  website: string;
  enforceOtp: boolean;
  longPollTimeoutSec: number;
  longPollJitterSec: number;
  // https tls
  tls: 'self' | 'acme' | 'custom';
  randomizeJarm: boolean;
  // dns
  domains: string; // newline-separated
  canaries: boolean;
  // wg
  tunIp: string;
  nPort: number;
  keyPort: number;
  // stager
  stagerProto: number;
  profileName: string;
}

/** Webview form for starting any listener type with its full option set. */
export class ListenerPanel {
  private static current?: ListenerPanel;

  static open(client: SliverClient): void {
    if (ListenerPanel.current) {
      ListenerPanel.current.client = client;
      ListenerPanel.current.panel.reveal();
      void ListenerPanel.current.sendContext();
      return;
    }
    ListenerPanel.current = new ListenerPanel(client);
  }

  private readonly panel: vscode.WebviewPanel;
  private cert?: Buffer;
  private key?: Buffer;

  private constructor(private client: SliverClient) {
    this.panel = vscode.window.createWebviewPanel('sliver.listener', 'Start Listener', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.onDidDispose(() => (ListenerPanel.current = undefined));
    void this.sendContext();
  }

  /** Send the existing websites (for the "serve website" dropdown). */
  private async sendContext(): Promise<void> {
    try {
      const { Websites } = await this.client.websites();
      this.post({ type: 'websites', names: (Websites ?? []).map((w: any) => w.Name) });
    } catch {
      /* ignore */
    }
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: { type: string; form?: ListenerForm; which?: 'cert' | 'key' }): Promise<void> {
    if (msg.type === 'ready') {
      void this.sendContext();
      return;
    }
    if (msg.type === 'pickFile' && msg.which) {
      const file = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: `Select ${msg.which}` });
      if (file?.length) {
        const data = Buffer.from(await vscode.workspace.fs.readFile(file[0]));
        if (msg.which === 'cert') {
          this.cert = data;
        } else {
          this.key = data;
        }
        this.post({ type: 'fileChosen', which: msg.which, name: file[0].path.split('/').pop() });
      }
      return;
    }
    if (msg.type !== 'start' || !msg.form) {
      return;
    }
    await this.start(msg.form);
  }

  private async start(f: ListenerForm): Promise<void> {
    const host = f.host || '0.0.0.0';
    this.setBusy(true);
    try {
      let label = f.type.toUpperCase();
      if (f.type === 'mtls') {
        await this.client.startMtlsListener({ Host: host, Port: f.port });
      } else if (f.type === 'http' || f.type === 'https') {
        const secure = f.type === 'https';
        const NS = 1_000_000_000; // ns per second (Go time.Duration)
        const req: any = {
          Host: host,
          Port: f.port,
          Domain: f.domain || '',
          Website: f.website || '',
          Secure: secure,
          EnforceOTP: f.enforceOtp,
          LongPollTimeout: String(Math.max(0, Math.floor(f.longPollTimeoutSec || 0)) * NS),
          LongPollJitter: String(Math.max(0, Math.floor(f.longPollJitterSec || 0)) * NS),
        };
        if (secure) {
          req.ACME = f.tls === 'acme';
          req.RandomizeJARM = f.randomizeJarm;
          if (f.tls === 'custom') {
            if (!this.cert || !this.key) {
              throw new Error('Custom TLS selected but cert/key not chosen.');
            }
            req.Cert = this.cert;
            req.Key = this.key;
          }
        }
        if (secure) {
          await this.client.startHttpsListener(req);
        } else {
          await this.client.startHttpListener(req);
        }
        label = `${label}${f.domain ? ` (${f.domain})` : ''}${f.website ? ` serving "${f.website}"` : ''}`;
      } else if (f.type === 'dns') {
        const domains = f.domains.split('\n').map((d) => d.trim()).filter(Boolean);
        if (!domains.length) {
          throw new Error('DNS listener needs at least one domain (with trailing dot).');
        }
        await this.client.startDnsListener({ Host: host, Port: f.port, Domains: domains, Canaries: f.canaries, EnforceOTP: f.enforceOtp });
      } else if (f.type === 'wg') {
        await this.client.startWgListener({ Host: host, Port: f.port, TunIP: f.tunIp || '100.64.0.1', NPort: f.nPort || 8888, KeyPort: f.keyPort || 1337 });
      } else if (f.type === 'stager') {
        await this.client.startTcpStagerListener({ Protocol: f.stagerProto, Host: host, Port: f.port, ProfileName: f.profileName });
      }
      this.post({ type: 'status', text: `${label} listener started on ${host}:${f.port}`, kind: 'ok' });
      void vscode.window.showInformationMessage(`${label} listener started on ${host}:${f.port}`);
      void vscode.commands.executeCommand('sliver.refresh');
    } catch (err) {
      this.post({ type: 'status', text: `Error: ${(err as Error).message}`, kind: 'err' });
      void vscode.window.showErrorMessage(`Start listener failed: ${(err as Error).message}`);
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    this.post({ type: 'busy', busy });
  }

  private html(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">${cspMeta(this.panel.webview, nonce)}
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; max-width: 560px; }
  label { display: block; margin: 12px 0 4px; font-size: 12px; opacity: 0.85; }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font-family: inherit; }
  textarea { resize: vertical; min-height: 48px; }
  .row { display: flex; gap: 12px; } .row > div { flex: 1; }
  .check { display: flex; align-items: center; gap: 6px; margin-top: 12px; } .check input { width: auto; }
  h3 { margin: 22px 0 0; font-size: 12px; text-transform: uppercase; opacity: 0.6; }
  .hint { font-size: 11px; opacity: 0.6; margin-top: 4px; }
  details { margin-top: 12px; } summary { cursor: pointer; font-size: 12px; opacity: 0.7; padding: 6px 0; }
  .hidden { display: none; }
  button { margin-top: 18px; padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); } button:disabled { opacity: 0.5; }
  .small { padding: 4px 10px; margin-top: 4px; background: var(--vscode-button-secondaryBackground,#3a3d41); color: var(--vscode-button-secondaryForeground,#fff); }
  #status { margin-top: 14px; font-size: 12px; white-space: pre-wrap; }
  #status.ok { color: var(--vscode-terminal-ansiGreen); } #status.err { color: var(--vscode-terminal-ansiRed); }
</style></head><body>
  <h2>Start Listener</h2>
  <label>Type</label>
  <select id="type">
    <option value="https">HTTPS (C2)</option>
    <option value="http">HTTP (C2)</option>
    <option value="mtls">mTLS</option>
    <option value="dns">DNS</option>
    <option value="wg">WireGuard</option>
    <option value="stager">TCP Stager</option>
  </select>
  <div class="row">
    <div><label>Bind host</label><input id="host" value="0.0.0.0" /></div>
    <div><label>Port</label><input id="port" type="number" value="443" /></div>
  </div>

  <div id="http-fields">
    <h3>HTTP options</h3>
    <label>C2 domain (optional — restricts callbacks to this host header)</label>
    <input id="domain" placeholder="example.com" />
    <label>Serve a website (optional)</label>
    <select id="website"><option value="">— none —</option></select>
    <div class="check"><input type="checkbox" id="enforceOtp" /><label style="margin:0">Enforce OTP</label></div>
    <details>
      <summary>Advanced (long-poll)</summary>
      <div class="row">
        <div><label>Long-poll timeout (s)</label><input id="longPollTimeoutSec" type="number" value="1" min="0" /></div>
        <div><label>Long-poll jitter (s)</label><input id="longPollJitterSec" type="number" value="2" min="0" /></div>
      </div>
      <div class="hint">How long the server holds an HTTP poll open before replying (0 = server default).</div>
    </details>
  </div>

  <div id="tls-fields">
    <h3>TLS (HTTPS)</h3>
    <label>Certificate source</label>
    <select id="tls">
      <option value="self">Self-signed (auto)</option>
      <option value="acme">ACME / Let's Encrypt (uses the C2 domain above)</option>
      <option value="custom">Custom certificate + key</option>
    </select>
    <div id="custom-tls" class="hidden">
      <button class="small" id="pickCert">Choose certificate…</button> <span id="certName"></span><br/>
      <button class="small" id="pickKey">Choose private key…</button> <span id="keyName"></span>
    </div>
    <div class="check"><input type="checkbox" id="randomizeJarm" checked /><label style="margin:0">Randomize JARM fingerprint</label></div>
  </div>

  <div id="dns-fields" class="hidden">
    <h3>DNS options</h3>
    <label>Domains (one per line, with trailing dot)</label>
    <textarea id="domains" placeholder="1.example.com."></textarea>
    <div class="check"><input type="checkbox" id="canaries" checked /><label style="margin:0">Enable canaries</label></div>
    <div class="check"><input type="checkbox" id="dnsOtp" /><label style="margin:0">Enforce OTP</label></div>
  </div>

  <div id="wg-fields" class="hidden">
    <h3>WireGuard options</h3>
    <div class="row">
      <div><label>Tunnel IP</label><input id="tunIp" value="100.64.0.1" /></div>
      <div><label>N port</label><input id="nPort" type="number" value="8888" /></div>
      <div><label>Key port</label><input id="keyPort" type="number" value="1337" /></div>
    </div>
  </div>

  <div id="stager-fields" class="hidden">
    <h3>Stager options</h3>
    <label>Stage protocol</label>
    <select id="stagerProto"><option value="0">TCP</option><option value="1">HTTP</option><option value="2">HTTPS</option></select>
    <label>Profile name (saved implant profile to stage)</label>
    <input id="profileName" />
  </div>

  <button id="go">Start Listener</button>
  <div id="status"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const DEFAULT_PORT = { https: 443, http: 80, mtls: 8888, dns: 53, wg: 53, stager: 8443 };
  function sync() {
    const t = $('type').value;
    $('http-fields').classList.toggle('hidden', !(t === 'http' || t === 'https'));
    $('tls-fields').classList.toggle('hidden', t !== 'https');
    $('dns-fields').classList.toggle('hidden', t !== 'dns');
    $('wg-fields').classList.toggle('hidden', t !== 'wg');
    $('stager-fields').classList.toggle('hidden', t !== 'stager');
    $('custom-tls').classList.toggle('hidden', $('tls').value !== 'custom');
  }
  $('type').addEventListener('change', () => { $('port').value = DEFAULT_PORT[$('type').value]; sync(); });
  $('tls').addEventListener('change', sync);
  $('pickCert').addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ type: 'pickFile', which: 'cert' }); });
  $('pickKey').addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ type: 'pickFile', which: 'key' }); });
  $('go').addEventListener('click', () => {
    vscode.postMessage({ type: 'start', form: {
      type: $('type').value, host: $('host').value.trim(), port: parseInt($('port').value, 10) || 0,
      domain: $('domain').value.trim(), website: $('website').value, enforceOtp: $('enforceOtp').checked || $('dnsOtp').checked,
      longPollTimeoutSec: parseInt($('longPollTimeoutSec').value, 10) || 0, longPollJitterSec: parseInt($('longPollJitterSec').value, 10) || 0,
      tls: $('tls').value, randomizeJarm: $('randomizeJarm').checked,
      domains: $('domains').value, canaries: $('canaries').checked,
      tunIp: $('tunIp').value.trim(), nPort: parseInt($('nPort').value,10)||0, keyPort: parseInt($('keyPort').value,10)||0,
      stagerProto: parseInt($('stagerProto').value,10)||0, profileName: $('profileName').value.trim(),
    }});
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'websites') $('website').innerHTML = '<option value="">— none —</option>' + m.names.map((n) => '<option>'+n+'</option>').join('');
    else if (m.type === 'fileChosen') $(m.which === 'cert' ? 'certName' : 'keyName').textContent = m.name;
    else if (m.type === 'status') { const s = $('status'); s.textContent = m.text; s.className = m.kind || ''; }
    else if (m.type === 'busy') { $('go').disabled = m.busy; $('go').textContent = m.busy ? 'Starting…' : 'Start Listener'; }
  });
  sync();
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}
