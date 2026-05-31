import * as vscode from 'vscode';
import { SliverClient } from '../client/SliverClient';
import { getNonce, cspMeta } from './webviewUtil';
import { RAW_METHODS } from '../grpc/rawMethods';
import * as clientpb from '../grpc/clientpb/client';
import * as sliverpb from '../grpc/sliverpb/sliver';
import * as commonpb from '../grpc/commonpb/common';

// ts-proto message objects expose encode/decode/fromJSON/toJSON.
interface MessageFns {
  encode(msg: any): { finish(): Uint8Array };
  decode(buf: Uint8Array): any;
  fromJSON(o: any): any;
  toJSON(m: any): unknown;
}

/** Resolve a message-type name to its ts-proto codec across the three namespaces. */
function resolveType(name: string): MessageFns | undefined {
  const ns: any[] = [clientpb, sliverpb, commonpb];
  for (const n of ns) {
    if (n[name] && typeof n[name].encode === 'function') {
      return n[name] as MessageFns;
    }
  }
  return undefined;
}

/**
 * Raw gRPC console. Send any unary SliverRPC method (or an arbitrary method path
 * on a forked server) over the same authenticated channel. For known methods the
 * request/response are edited/shown as JSON (marshaled via the typed codec); for
 * a custom path you supply raw request bytes (hex or base64) and get raw bytes.
 */
export class RawRpcPanel {
  private static current?: RawRpcPanel;

  static open(client: SliverClient): void {
    if (RawRpcPanel.current) {
      RawRpcPanel.current.client = client;
      RawRpcPanel.current.panel.reveal();
      return;
    }
    RawRpcPanel.current = new RawRpcPanel(client);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(private client: SliverClient) {
    this.panel = vscode.window.createWebviewPanel('sliver.rawRpc', 'Raw gRPC Request', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.onDidDispose(() => (RawRpcPanel.current = undefined));
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: any): Promise<void> {
    if (msg.type === 'ready') {
      // Feed the method list (path + req/resp type names) to the form.
      this.post({ type: 'methods', methods: RAW_METHODS });
      return;
    }
    if (msg.type === 'send') {
      await this.send(msg);
    }
  }

  private async send(msg: { path: string; mode: 'json' | 'raw'; body: string; reqType?: string; respType?: string; encoding?: 'hex' | 'base64' }): Promise<void> {
    this.post({ type: 'busy', busy: true });
    try {
      // 1) Build request bytes.
      let reqBytes: Buffer;
      if (msg.mode === 'json') {
        const fns = msg.reqType ? resolveType(msg.reqType) : undefined;
        if (!fns) {
          throw new Error(`Unknown request type "${msg.reqType}" — switch to Raw mode for a custom endpoint.`);
        }
        const obj = msg.body.trim() ? JSON.parse(msg.body) : {};
        reqBytes = Buffer.from(fns.encode(fns.fromJSON(obj)).finish());
      } else {
        const enc = msg.encoding ?? 'hex';
        reqBytes = msg.body.trim() ? Buffer.from(msg.body.replace(/\s+/g, ''), enc) : Buffer.alloc(0);
      }

      // 2) Fire it on the authenticated channel.
      const t0 = Date.now();
      const respBytes = await this.client.rawUnary(msg.path, reqBytes);
      const ms = Date.now() - t0;

      // 3) Decode response.
      let out: string;
      const respFns = msg.respType ? resolveType(msg.respType) : undefined;
      if (msg.mode === 'json' && respFns) {
        out = JSON.stringify(respFns.toJSON(respFns.decode(respBytes)), null, 2);
      } else {
        out = `${respBytes.length} bytes\nhex:    ${respBytes.toString('hex')}\nbase64: ${respBytes.toString('base64')}`;
      }
      this.post({ type: 'result', ok: true, text: out, meta: `${respBytes.length} bytes · ${ms} ms · sent ${reqBytes.length} bytes` });
    } catch (e: any) {
      // gRPC errors carry a numeric code + details; surface both.
      const code = e?.code !== undefined ? `gRPC ${e.code}` : 'Error';
      this.post({ type: 'result', ok: false, text: `${code}: ${e?.details || e?.message || String(e)}` });
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private html(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">${cspMeta(this.panel.webview, nonce)}
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; max-width: 760px; }
  h2 { margin: 0 0 4px; }
  .hint { font-size: 12px; opacity: 0.7; margin: 4px 0 12px; }
  label { display: block; margin: 12px 0 4px; font-size: 12px; opacity: 0.85; }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font-family: inherit; }
  textarea { resize: vertical; min-height: 120px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .row { display: flex; gap: 12px; align-items: flex-end; } .row > div { flex: 1; }
  .hidden { display: none; }
  code { font-family: var(--vscode-editor-font-family, monospace); }
  button { margin-top: 14px; padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); } button:disabled { opacity: 0.5; }
  #meta { font-size: 11px; opacity: 0.7; margin-top: 8px; }
  #result { margin-top: 6px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; background: var(--vscode-textCodeBlock-background, #1e1e1e); padding: 10px; border-radius: 3px; max-height: 40vh; overflow: auto; }
  #result.err { color: var(--vscode-terminal-ansiRed); }
  #result.ok { color: var(--vscode-terminal-ansiGreen); }
</style></head><body>
  <h2>Raw gRPC Request</h2>
  <div class="hint">Send any unary <code>SliverRPC</code> method over the authenticated channel. Pick a known method to edit the request as JSON, or choose <b>Custom path…</b> to hit an arbitrary endpoint (e.g. on a forked server) with raw request bytes.</div>

  <label>Method</label>
  <select id="method"></select>

  <div id="customPathWrap" class="hidden">
    <label>Custom method path</label>
    <input id="customPath" placeholder="/rpcpb.SliverRPC/MyMethod  or  /my.pkg.Service/Method" />
  </div>

  <div id="typeInfo" class="hint"></div>

  <div class="row">
    <div>
      <label>Body mode</label>
      <select id="mode">
        <option value="json">JSON (typed marshal)</option>
        <option value="raw">Raw bytes</option>
      </select>
    </div>
    <div id="encWrap" class="hidden">
      <label>Encoding</label>
      <select id="encoding"><option value="hex">hex</option><option value="base64">base64</option></select>
    </div>
  </div>

  <label id="bodyLabel">Request (JSON)</label>
  <textarea id="body" placeholder="{}"></textarea>

  <button id="send">Send</button>
  <div id="meta"></div>
  <div id="result"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let METHODS = [];
  const CUSTOM = '__custom__';

  function selectedDef() {
    const v = $('method').value;
    if (v === CUSTOM) return null;
    return METHODS.find((m) => m.path === v) || null;
  }
  function sync() {
    const isCustom = $('method').value === CUSTOM;
    $('customPathWrap').classList.toggle('hidden', !isCustom);
    const def = selectedDef();
    // Custom path can only use raw mode (no known types).
    if (isCustom) { $('mode').value = 'raw'; $('mode').disabled = true; }
    else { $('mode').disabled = false; }
    const raw = $('mode').value === 'raw';
    $('encWrap').classList.toggle('hidden', !raw);
    $('bodyLabel').textContent = raw ? 'Request (raw bytes)' : 'Request (JSON)';
    $('body').placeholder = raw ? '(blank = empty message) e.g. 0a03...' : '{}';
    $('typeInfo').textContent = def ? ('request: ' + def.req + '   →   response: ' + def.resp) : (isCustom ? 'custom endpoint — raw bytes only' : '');
  }
  $('method').addEventListener('change', sync);
  $('mode').addEventListener('change', sync);
  $('send').addEventListener('click', () => {
    const def = selectedDef();
    const isCustom = $('method').value === CUSTOM;
    const path = isCustom ? $('customPath').value.trim() : $('method').value;
    if (!path) { $('result').textContent = 'Enter a method path.'; $('result').className = 'err'; return; }
    vscode.postMessage({
      type: 'send', path, mode: $('mode').value, body: $('body').value,
      reqType: def && def.req, respType: def && def.resp, encoding: $('encoding').value,
    });
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'methods') {
      METHODS = m.methods;
      const opts = METHODS.map((x) => '<option value="' + x.path + '">' + x.path.replace('/rpcpb.SliverRPC/', '') + '</option>').join('');
      $('method').innerHTML = opts + '<option value="' + CUSTOM + '">Custom path…</option>';
      // Default to GetVersion for an obvious first try.
      const gv = METHODS.find((x) => x.path.endsWith('/GetVersion'));
      if (gv) $('method').value = gv.path;
      sync();
    } else if (m.type === 'busy') {
      $('send').disabled = m.busy; $('send').textContent = m.busy ? 'Sending…' : 'Send';
    } else if (m.type === 'result') {
      $('result').textContent = m.text; $('result').className = m.ok ? 'ok' : 'err';
      $('meta').textContent = m.meta || '';
    }
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}
