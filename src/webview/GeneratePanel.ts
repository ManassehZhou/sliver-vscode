import * as vscode from 'vscode';
import { SliverClient } from '../client/SliverClient';
import { OutputFormat } from '../grpc/clientpb/client';
import { getNonce, cspMeta } from './webviewUtil';

interface GenerateForm {
  name: string;
  goos: string;
  goarch: string;
  format: number;
  isBeacon: boolean;
  beaconIntervalSec: number;
  beaconJitterSec: number;
  reconnectSec: number;
  maxErrors: number;
  c2: string; // newline-separated URLs
  obfuscate: boolean;
  debug: boolean;
  runAtLoad: boolean;
}

const SEC = 1_000_000_000; // ns per second

/** Webview form that drives the Generate RPC and saves the resulting implant. */
export class GeneratePanel {
  private static current?: GeneratePanel;

  static open(client: SliverClient): void {
    if (GeneratePanel.current) {
      GeneratePanel.current.client = client;
      GeneratePanel.current.panel.reveal();
      void GeneratePanel.current.sendListeners();
      return;
    }
    GeneratePanel.current = new GeneratePanel(client);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(private client: SliverClient) {
    this.panel = vscode.window.createWebviewPanel('sliver.generate', 'Generate Implant', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => (GeneratePanel.current = undefined));
    void this.sendListeners();
  }

  /** Suggest C2 URLs from the server's running listeners (host = operator's lhost). */
  private async sendListeners(): Promise<void> {
    try {
      const { Active } = await this.client.getJobs();
      const host = this.client.config.lhost;
      // For Sliver listeners the C2 scheme is in Job.Name (mtls/http/https/dns);
      // Job.Protocol is the transport (tcp/udp), so filter/derive from Name.
      const suggestions = Active.filter((j) => /^(mtls|http|https|dns|wg)$/i.test(j.Name)).map((j) => {
        const scheme = j.Name.toLowerCase();
        const domain = j.Domains.find((d) => d);
        const hostPart = scheme === 'dns' && domain ? domain : host;
        return { label: `${j.Name} (${j.Protocol}/${j.Port})  →  ${scheme}://${hostPart}:${j.Port}`, url: `${scheme}://${hostPart}:${j.Port}` };
      });
      this.post({ type: 'listeners', suggestions });
    } catch {
      /* ignore — form still works with manual URLs */
    }
  }

  /** Turn the form into an ImplantConfig (shared by generate + save-as-profile). */
  private formToConfig(f: GenerateForm, name: string): any {
    const c2Urls = f.c2
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      GOOS: f.goos,
      GOARCH: f.goarch,
      Format: f.format as OutputFormat,
      IsBeacon: f.isBeacon,
      BeaconInterval: String(Math.max(0, Math.floor(f.beaconIntervalSec)) * SEC),
      BeaconJitter: String(Math.max(0, Math.floor(f.beaconJitterSec)) * SEC),
      ReconnectInterval: String(Math.max(0, Math.floor(f.reconnectSec)) * SEC),
      MaxConnectionErrors: Math.max(0, Math.floor(f.maxErrors)),
      ObfuscateSymbols: f.obfuscate,
      Debug: f.debug,
      RunAtLoad: f.runAtLoad,
      C2: c2Urls.map((url, i) => ({ Priority: i, URL: url, Options: '' })),
      TemplateName: 'sliver',
      HTTPC2ConfigName: 'default',
      Name: name,
    };
  }

  private hasC2(f: GenerateForm): boolean {
    if (f.c2.split('\n').some((s) => s.trim())) {
      return true;
    }
    this.post({ type: 'status', text: 'Add at least one C2 URL.', kind: 'err' });
    void vscode.window.showErrorMessage('Add at least one C2 URL (e.g. mtls://host:8888).');
    return false;
  }

  private async onMessage(msg: { type: string; form?: GenerateForm }): Promise<void> {
    if (msg.type === 'ready') {
      void this.sendListeners();
      return;
    }
    if (!msg.form || !this.hasC2(msg.form)) {
      return;
    }
    const f = msg.form;
    if (msg.type === 'generate') {
      await this.runBuild(f.name, (name) => this.formToConfig(f, name));
    } else if (msg.type === 'saveProfile') {
      const profileName = await vscode.window.showInputBox({
        prompt: 'Profile name',
        value: f.name || `${f.goos}-${f.isBeacon ? 'beacon' : 'session'}`,
      });
      if (!profileName) {
        return;
      }
      try {
        await this.client.saveImplantProfile({ Name: profileName, Config: this.formToConfig(f, profileName) });
        this.post({ type: 'status', text: `Saved profile "${profileName}".`, kind: 'ok' });
        void vscode.window.showInformationMessage(`Saved implant profile "${profileName}". Find it under Server → Profiles.`);
        void vscode.commands.executeCommand('sliver.server.refresh');
      } catch (err) {
        this.post({ type: 'status', text: `Save profile failed: ${(err as Error).message}`, kind: 'err' });
      }
    }
  }

  /** Run the build inside a progress notification, with collision-aware retry. */
  private async runBuild(name: string, buildConfig: (n: string) => any): Promise<void> {
    this.setBusy(true);
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Building implant${name ? ` "${name}"` : ''}…`, cancellable: false },
        async () => {
          try {
            return await this.client.generate({ Name: name, Config: buildConfig(name) });
          } catch (err) {
            const msg = (err as Error).message;
            // Stale server build dir from an interrupted build of this name.
            if (/target exists|import dir|already exists/i.test(msg) && name) {
              const unique = `${name}_${Math.random().toString(36).slice(2, 7)}`;
              const choice = await vscode.window.showWarningMessage(
                `A stale server build dir is blocking the name "${name}". Retry as "${unique}"?`,
                'Retry',
              );
              if (choice === 'Retry') {
                return await this.client.generate({ Name: unique, Config: buildConfig(unique) });
              }
            }
            throw err;
          }
        },
      );

      if (!res.File) {
        this.post({ type: 'status', text: 'Server returned no file.', kind: 'err' });
        void vscode.window.showWarningMessage('Generate: server returned no file.');
        return;
      }
      const dest = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(res.File.Name || name || 'implant'),
        saveLabel: 'Save Implant',
      });
      if (dest) {
        await vscode.workspace.fs.writeFile(dest, new Uint8Array(Buffer.from(res.File.Data)));
        this.post({ type: 'status', text: `Saved ${res.File.Data.length} bytes → ${dest.fsPath}`, kind: 'ok' });
        void vscode.window.showInformationMessage(`Implant "${res.File.Name}" saved to ${dest.fsPath}`);
      } else {
        this.post({ type: 'status', text: `Built "${res.File.Name}" (save cancelled).`, kind: 'ok' });
      }
    } catch (err) {
      const msg = (err as Error).message;
      this.post({ type: 'status', text: `Error: ${msg}`, kind: 'err' });
      void vscode.window.showErrorMessage(`Generate failed: ${msg}`);
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    this.post({ type: 'busy', busy });
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private html(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${cspMeta(this.panel.webview, nonce)}
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; max-width: 560px; }
  label { display: block; margin: 12px 0 4px; font-size: 12px; opacity: 0.85; }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font-family: inherit; }
  textarea { resize: vertical; min-height: 52px; }
  .row { display: flex; gap: 12px; }
  .row > div { flex: 1; }
  .check { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
  .check input { width: auto; }
  h3 { margin: 22px 0 0; font-size: 12px; text-transform: uppercase; opacity: 0.6; }
  button { margin-top: 18px; padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  #status { margin-top: 14px; font-size: 12px; white-space: pre-wrap; }
  #status.ok { color: var(--vscode-terminal-ansiGreen); }
  #status.err { color: var(--vscode-terminal-ansiRed); }
</style>
</head>
<body>
  <h2>Generate Implant</h2>

  <label>Name (blank = unique random name)</label>
  <input id="name" placeholder="auto-generated if blank" />

  <div class="row">
    <div><label>OS</label><select id="goos"><option>windows</option><option>linux</option><option>darwin</option></select></div>
    <div><label>Arch</label><select id="goarch"><option>amd64</option><option>386</option><option>arm64</option></select></div>
    <div><label>Format</label>
      <select id="format"><option value="2">Executable</option><option value="0">Shared Library</option><option value="1">Shellcode</option><option value="3">Service</option></select>
    </div>
  </div>

  <h3>Command &amp; Control</h3>
  <label>Add C2 from a running listener</label>
  <select id="listeners"><option value="">— select a listener —</option></select>
  <label>C2 URLs (one per line, in priority order)</label>
  <textarea id="c2" placeholder="mtls://192.168.1.10:8888"></textarea>

  <h3>Behaviour</h3>
  <div class="check"><input type="checkbox" id="isBeacon" /><label style="margin:0">Beacon mode</label></div>
  <div class="row">
    <div><label>Beacon interval (s)</label><input id="beaconIntervalSec" type="number" value="60" min="0" /></div>
    <div><label>Beacon jitter (s)</label><input id="beaconJitterSec" type="number" value="30" min="0" /></div>
  </div>
  <div class="row">
    <div><label>Reconnect interval (s)</label><input id="reconnectSec" type="number" value="60" min="0" /></div>
    <div><label>Max connection errors</label><input id="maxErrors" type="number" value="1000" min="0" /></div>
  </div>
  <div class="check"><input type="checkbox" id="obfuscate" /><label style="margin:0">Obfuscate symbols</label></div>
  <div class="check"><input type="checkbox" id="runAtLoad" /><label style="margin:0">Run at load</label></div>
  <div class="check"><input type="checkbox" id="debug" /><label style="margin:0">Debug build</label></div>

  <button id="go">Generate</button>
  <button id="saveProfile" style="background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff);">Save as Profile</button>
  <div id="status"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  $('listeners').addEventListener('change', (e) => {
    const url = e.target.value;
    if (url) { const ta = $('c2'); ta.value = (ta.value ? ta.value.replace(/\\s*$/, '') + '\\n' : '') + url; e.target.value = ''; }
  });
  const readForm = () => ({
    name: $('name').value.trim(),
    goos: $('goos').value, goarch: $('goarch').value, format: parseInt($('format').value, 10),
    isBeacon: $('isBeacon').checked,
    beaconIntervalSec: parseInt($('beaconIntervalSec').value, 10) || 0,
    beaconJitterSec: parseInt($('beaconJitterSec').value, 10) || 0,
    reconnectSec: parseInt($('reconnectSec').value, 10) || 0,
    maxErrors: parseInt($('maxErrors').value, 10) || 0,
    c2: $('c2').value, obfuscate: $('obfuscate').checked, runAtLoad: $('runAtLoad').checked, debug: $('debug').checked,
  });
  $('go').addEventListener('click', () => vscode.postMessage({ type: 'generate', form: readForm() }));
  $('saveProfile').addEventListener('click', () => vscode.postMessage({ type: 'saveProfile', form: readForm() }));
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'status') { const s = $('status'); s.textContent = m.text; s.className = m.kind || ''; }
    else if (m.type === 'busy') { $('go').disabled = m.busy; $('go').textContent = m.busy ? 'Building…' : 'Generate'; }
    else if (m.type === 'listeners') {
      const sel = $('listeners');
      sel.innerHTML = '<option value="">— select a listener —</option>' + m.suggestions.map((s) => '<option value="' + s.url + '">' + s.label + '</option>').join('');
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
