import * as vscode from 'vscode';
import { SliverClient } from '../client/SliverClient';
import { getNonce, cspMeta } from './webviewUtil';

/**
 * Full editor for an HTTP-C2 profile (HTTPC2Config). The config is deeply
 * nested (server headers/cookies + implant user-agent/headers/url-params/
 * path-segments/extensions and a dozen tuning ints), so we expose it as
 * editable JSON — the same shape Sliver's own `http-c2.json` uses — which
 * guarantees 100% field coverage. Save calls SaveHTTPC2Profile(overwrite).
 */
export class C2ProfilePanel {
  private static current?: C2ProfilePanel;

  static open(client: SliverClient, profileName: string, config: any, refresh: () => void): void {
    if (C2ProfilePanel.current) {
      const p = C2ProfilePanel.current;
      p.client = client;
      p.refresh = refresh;
      p.config = config;
      p.panel.title = `C2 Profile: ${profileName}`;
      p.panel.reveal();
      p.post({ type: 'load', text: JSON.stringify(config, null, 2) });
      return;
    }
    C2ProfilePanel.current = new C2ProfilePanel(client, profileName, config, refresh);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private client: SliverClient,
    profileName: string,
    private config: any,
    private refresh: () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel('sliver.c2profile', `C2 Profile: ${profileName}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.onDidDispose(() => (C2ProfilePanel.current = undefined));
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: { type: string; text?: string }): Promise<void> {
    if (msg.type === 'ready') {
      this.post({ type: 'load', text: JSON.stringify(this.config, null, 2) });
      return;
    }
    if (msg.type !== 'save' || msg.text === undefined) {
      return;
    }
    let cfg: any;
    try {
      cfg = JSON.parse(msg.text);
    } catch (e) {
      this.post({ type: 'status', text: `Invalid JSON: ${(e as Error).message}`, kind: 'err' });
      return;
    }
    if (!cfg.Name || typeof cfg.Name !== 'string') {
      this.post({ type: 'status', text: 'Profile must have a non-empty string "Name".', kind: 'err' });
      return;
    }
    this.post({ type: 'busy', busy: true });
    try {
      // Sliver's SaveHTTPC2Profile distinguishes create (overwrite=false, name
      // must NOT exist) from update (overwrite=true, name MUST exist). Probe by
      // name (the list RPC only returns "default") — handles new/edit/rename.
      const overwrite = await this.client.httpC2ProfileExists(cfg.Name);
      await this.client.saveHttpC2Profile(cfg, overwrite);
      this.config = cfg;
      this.panel.title = `C2 Profile: ${cfg.Name}`;
      this.post({ type: 'status', text: `Saved profile "${cfg.Name}".`, kind: 'ok' });
      void vscode.window.showInformationMessage(`Saved HTTP-C2 profile "${cfg.Name}". Pick it in the Generate panel.`);
      this.refresh();
    } catch (e) {
      this.post({ type: 'status', text: `Save failed: ${(e as Error).message}`, kind: 'err' });
      void vscode.window.showErrorMessage(`Save HTTP-C2 profile failed: ${(e as Error).message}`);
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private html(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">${cspMeta(this.panel.webview, nonce)}
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  h2 { margin: 0 0 4px; }
  .hint { font-size: 12px; opacity: 0.7; margin: 4px 0 10px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 60vh; padding: 8px; tab-size: 2;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #444); border-radius: 2px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  details { margin: 8px 0; } summary { cursor: pointer; font-size: 12px; opacity: 0.75; }
  details ul { font-size: 12px; opacity: 0.85; margin: 6px 0; line-height: 1.5; }
  code { font-family: var(--vscode-editor-font-family, monospace); }
  button { margin-top: 12px; padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); } button:disabled { opacity: 0.5; }
  #status { margin-top: 10px; font-size: 12px; white-space: pre-wrap; }
  #status.ok { color: var(--vscode-terminal-ansiGreen); } #status.err { color: var(--vscode-terminal-ansiRed); }
</style></head><body>
  <h2>Edit HTTP-C2 Profile</h2>
  <div class="hint">Defines how implants disguise their HTTP traffic. Edit the JSON below and Save (overwrites by <code>Name</code>).</div>
  <details>
    <summary>Field guide</summary>
    <ul>
      <li><b>Name</b> — profile id; referenced from the Generate form's "HTTP C2 profile".</li>
      <li><b>ServerConfig.Headers / Cookies</b> — response headers &amp; cookie names the C2 server emits. <b>RandomVersionHeaders</b> rotates Server/X-Powered-By style headers.</li>
      <li><b>ImplantConfig.UserAgent</b> — request UA (blank = randomized Chrome). <b>ChromeBaseVersion</b>/<b>MacOSVersion</b> seed that randomization.</li>
      <li><b>ImplantConfig.PathSegments</b> — URL building blocks; each has <code>IsFile</code> (false=directory, true=filename) and <code>Value</code>.</li>
      <li><b>extensions</b> — file extensions appended to request paths (e.g. <code>.js</code>, <code>.php</code>).</li>
      <li><b>Min/Max PathGen, FileGen, PathLength</b> — how many dirs/files and how long generated URLs are.</li>
      <li><b>ExtraURLParameters / Headers</b> — extra query params / request headers, each with a <code>Probability</code>.</li>
      <li><b>NonceMode / NonceQueryLength / NonceQueryArgChars</b> — the per-request nonce used to key sessions.</li>
    </ul>
  </details>
  <textarea id="json" spellcheck="false"></textarea>
  <div><button id="save">Save Profile</button></div>
  <div id="status"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  $('save').addEventListener('click', () => vscode.postMessage({ type: 'save', text: $('json').value }));
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'load') { $('json').value = m.text; }
    else if (m.type === 'status') { const s = $('status'); s.textContent = m.text; s.className = m.kind || ''; }
    else if (m.type === 'busy') { $('save').disabled = m.busy; $('save').textContent = m.busy ? 'Saving…' : 'Save Profile'; }
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}
