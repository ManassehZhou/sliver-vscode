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
  // advanced
  c2profile: string; // HTTPC2ConfigName — controls URL paths/extensions/UA/headers
  pollTimeoutSec: number;
  connStrategy: string; // '' | 's' | 'r' | 'rd'
  evasion: boolean;
  netgo: boolean;
  disableSgn: boolean;
  trafficEncoders: string[];
  canaryDomains: string; // newline-separated
  limitHostname: string;
  limitUsername: string;
  limitDatetime: string;
  limitFileExists: string;
  limitLocale: string;
  limitDomainJoined: boolean;
  debugFile: string;
  // external builder
  external: boolean;
  builder: string;
}

const SEC = 1_000_000_000; // ns per second

/** Webview form that drives the Generate RPC and saves the resulting implant. */
export class GeneratePanel {
  private static current?: GeneratePanel;

  static open(client: SliverClient): void {
    if (GeneratePanel.current) {
      const p = GeneratePanel.current;
      p.client = client;
      p.editProfileName = undefined;
      p.pendingInit = undefined;
      p.post({ type: 'resetProfileMode' });
      p.panel.reveal();
      void p.sendContext();
      return;
    }
    GeneratePanel.current = new GeneratePanel(client);
  }

  /** Open the form pre-filled with an existing profile's config, in edit mode. */
  static openForProfile(client: SliverClient, profileName: string, config: any): void {
    const p = GeneratePanel.current ?? (GeneratePanel.current = new GeneratePanel(client));
    p.client = client;
    p.editProfileName = profileName;
    p.pendingInit = p.configToForm(config);
    p.panel.reveal();
    void p.sendContext();
    // Deliver now (covers an already-open panel); also re-sent on the webview's 'ready'.
    p.post({ type: 'init', form: p.pendingInit, editProfile: profileName });
  }

  private readonly panel: vscode.WebviewPanel;
  private editProfileName?: string;
  private pendingInit?: GenerateForm;

  private constructor(private client: SliverClient) {
    this.panel = vscode.window.createWebviewPanel('sliver.generate', 'Generate Implant', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => (GeneratePanel.current = undefined));
    void this.sendContext();
  }

  /** Feed the form: C2 suggestions (running listeners), C2 profiles, traffic encoders. */
  private async sendContext(): Promise<void> {
    // C2 URL suggestions from running listeners (host = operator's lhost).
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
    // HTTP C2 profiles (these define the URL paths / extensions / UA an implant uses).
    try {
      const r = await this.client.getHttpC2Profiles();
      const names = (r.configs ?? []).map((c: any) => c.Name).filter(Boolean);
      this.post({ type: 'c2profiles', names: names.length ? names : ['default'] });
    } catch {
      this.post({ type: 'c2profiles', names: ['default'] });
    }
    // Traffic encoders (wasm) available on the server.
    try {
      const r = await this.client.trafficEncoderMap();
      this.post({ type: 'encoders', names: Object.keys(r.Encoders ?? {}) });
    } catch {
      /* ignore — section just stays empty */
    }
    // External builders registered with the server (for --external-builder).
    try {
      const r = await this.client.builders();
      const builders = (r.Builders ?? []).map((b: any) => ({
        name: b.Name,
        label: `${b.Name}  (${b.GOOS}/${b.GOARCH}${b.Templates?.length ? ', ' + b.Templates.join('/') : ''})`,
      }));
      this.post({ type: 'builders', builders });
    } catch {
      this.post({ type: 'builders', builders: [] });
    }
  }

  /** Inverse of formToConfig — populate the form from an existing ImplantConfig. */
  private configToForm(c: any): GenerateForm {
    const toSec = (v: any): number => Math.round((Number(v) || 0) / SEC);
    const c2 = (c.C2 ?? [])
      .slice()
      .sort((a: any, b: any) => (a.Priority ?? 0) - (b.Priority ?? 0))
      .map((x: any) => x.URL)
      .filter(Boolean)
      .join('\n');
    return {
      name: c.Name || '',
      goos: c.GOOS || 'windows',
      goarch: c.GOARCH || 'amd64',
      format: Number(c.Format) || 0,
      isBeacon: !!c.IsBeacon,
      beaconIntervalSec: toSec(c.BeaconInterval) || 60,
      beaconJitterSec: toSec(c.BeaconJitter) || 30,
      reconnectSec: toSec(c.ReconnectInterval) || 60,
      maxErrors: Number(c.MaxConnectionErrors) || 0,
      c2,
      obfuscate: !!c.ObfuscateSymbols,
      debug: !!c.Debug,
      runAtLoad: !!c.RunAtLoad,
      c2profile: c.HTTPC2ConfigName || 'default',
      pollTimeoutSec: toSec(c.PollTimeout),
      connStrategy: c.ConnectionStrategy || '',
      evasion: !!c.Evasion,
      netgo: !!c.NetGoEnabled,
      disableSgn: !c.SGNEnabled,
      trafficEncoders: c.TrafficEncoders ?? [],
      canaryDomains: (c.CanaryDomains ?? []).join('\n'),
      limitHostname: c.LimitHostname || '',
      limitUsername: c.LimitUsername || '',
      limitDatetime: c.LimitDatetime || '',
      limitFileExists: c.LimitFileExists || '',
      limitLocale: c.LimitLocale || '',
      limitDomainJoined: !!c.LimitDomainJoined,
      debugFile: c.DebugFile || '',
      // external-builder is a build-time choice, not part of a stored profile.
      external: false,
      builder: '',
    };
  }

  /** Turn the form into an ImplantConfig (shared by generate + save-as-profile). */
  private formToConfig(f: GenerateForm, name: string): any {
    const c2Urls = f.c2
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const lines = (s: string): string[] => s.split('\n').map((x) => x.trim()).filter(Boolean);
    const encoders = f.trafficEncoders.filter(Boolean);
    const cfg: any = {
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
      HTTPC2ConfigName: f.c2profile || 'default',
      Name: name,
      // advanced
      PollTimeout: String(Math.max(0, Math.floor(f.pollTimeoutSec)) * SEC),
      ConnectionStrategy: f.connStrategy || '',
      Evasion: f.evasion,
      NetGoEnabled: f.netgo,
      // SGN only applies to shellcode; only set it there to avoid surprising other formats.
      SGNEnabled: f.format === 1 && !f.disableSgn,
      TrafficEncodersEnabled: encoders.length > 0,
      TrafficEncoders: encoders,
      CanaryDomains: lines(f.canaryDomains),
      LimitHostname: f.limitHostname.trim(),
      LimitUsername: f.limitUsername.trim(),
      LimitDatetime: f.limitDatetime.trim(),
      LimitFileExists: f.limitFileExists.trim(),
      LimitLocale: f.limitLocale.trim(),
      LimitDomainJoined: f.limitDomainJoined,
      DebugFile: f.debugFile.trim(),
    };
    return cfg;
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
      void this.sendContext();
      if (this.pendingInit) {
        this.post({ type: 'init', form: this.pendingInit, editProfile: this.editProfileName });
      }
      return;
    }
    if (!msg.form || !this.hasC2(msg.form)) {
      return;
    }
    const f = msg.form;
    if (msg.type === 'generate') {
      if (f.external) {
        await this.runExternalBuild(f);
      } else {
        await this.runBuild(f.name, (name) => this.formToConfig(f, name));
      }
    } else if (msg.type === 'saveProfile') {
      // In edit mode the name is fixed (re-save overwrites the same profile).
      const profileName =
        this.editProfileName ??
        (await vscode.window.showInputBox({
          prompt: 'Profile name',
          value: f.name || `${f.goos}-${f.isBeacon ? 'beacon' : 'session'}`,
        }));
      if (!profileName) {
        return;
      }
      try {
        await this.client.saveImplantProfile({ Name: profileName, Config: this.formToConfig(f, profileName) });
        const verb = this.editProfileName ? 'Updated' : 'Saved';
        this.post({ type: 'status', text: `${verb} profile "${profileName}".`, kind: 'ok' });
        void vscode.window.showInformationMessage(`${verb} implant profile "${profileName}". Find it under Server → Profiles.`);
        void vscode.commands.executeCommand('sliver.server.refresh');
      } catch (err) {
        this.post({ type: 'status', text: `Save profile failed: ${(err as Error).message}`, kind: 'err' });
      }
    }
  }

  /**
   * Dispatch the build to an external builder. Unlike a normal build this does
   * NOT return a file — the builder compiles it asynchronously, then it shows up
   * under Server → Implant Builds. We send Name='' (server assigns a codename) to
   * dodge the same name-validation quirk the stager path hits.
   */
  private async runExternalBuild(f: GenerateForm): Promise<void> {
    if (!f.builder) {
      this.post({ type: 'status', text: 'Pick a builder (or uncheck “external builder”).', kind: 'err' });
      void vscode.window.showErrorMessage('No external builder selected. Register one on the server, or uncheck the option.');
      return;
    }
    this.setBusy(true);
    try {
      const cfg = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Dispatching build to "${f.builder}"…`, cancellable: false },
        () => this.client.generateExternal({ Name: f.name, BuilderName: f.builder, Config: this.formToConfig(f, f.name) }),
      );
      const buildId = (cfg as any)?.Build?.ID ?? '';
      const tmpl = (cfg as any)?.Config?.TemplateName ?? '';
      this.post({
        type: 'status',
        text: `Dispatched to "${f.builder}"${tmpl ? ` (template ${tmpl})` : ''}.\nThe builder is compiling it asynchronously — download from Server → Implant Builds when ready.${buildId ? `\nBuild ID: ${buildId}` : ''}`,
        kind: 'ok',
      });
      void vscode.window
        .showInformationMessage(
          `Build handed to "${f.builder}". It compiles asynchronously — grab the binary from Server → Implant Builds when done.`,
          'Open Implant Builds',
        )
        .then((pick) => {
          if (pick) {
            void vscode.commands.executeCommand('sliver.server.refresh');
            void vscode.commands.executeCommand('sliverServer.focus');
          }
        });
    } catch (err) {
      const msg = (err as Error).message;
      this.post({ type: 'status', text: `External build failed: ${msg}`, kind: 'err' });
      void vscode.window.showErrorMessage(`External build failed: ${msg}`);
    } finally {
      this.setBusy(false);
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
  select[multiple] { min-height: 72px; }
  .row { display: flex; gap: 12px; }
  .row > div { flex: 1; }
  .check { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
  .check input { width: auto; }
  h3 { margin: 22px 0 0; font-size: 12px; text-transform: uppercase; opacity: 0.6; }
  .hint { font-size: 11px; opacity: 0.6; margin-top: 2px; }
  .hidden { display: none; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; }
  .chip { margin: 0; padding: 3px 10px; font-size: 11px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); border: none; border-radius: 10px; cursor: pointer; }
  .chip:hover { background: var(--vscode-button-hoverBackground); }
  .optgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-top: 8px; }
  .optgrid label { margin: 0 0 2px; }
  .optbox { border: 1px solid var(--vscode-input-border, #444); border-radius: 3px; padding: 10px 12px; margin-top: 8px; }
  .optbox h4 { margin: 4px 0 2px; font-size: 11px; text-transform: uppercase; opacity: 0.6; }
  #editBanner { margin: 8px 0; padding: 6px 10px; border-radius: 3px; font-size: 12px; background: var(--vscode-inputValidation-infoBackground, #06314d); border: 1px solid var(--vscode-inputValidation-infoBorder, #1f6feb); }
  details { margin-top: 18px; border-top: 1px solid var(--vscode-input-border, #444); padding-top: 4px; }
  summary { cursor: pointer; font-size: 12px; text-transform: uppercase; opacity: 0.7; padding: 8px 0; }
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
  <div id="editBanner" class="hidden">Editing profile <b id="editName"></b> — “Save Profile” overwrites it; “Generate” builds an implant from it.</div>

  <label>Name (blank = unique random name)</label>
  <input id="name" placeholder="auto-generated if blank" />

  <div class="row">
    <div><label>OS</label><select id="goos"><option>windows</option><option>linux</option><option>darwin</option></select></div>
    <div><label>Arch</label><select id="goarch"><option>amd64</option><option>386</option><option>arm64</option></select></div>
    <div><label>Format</label>
      <select id="format"><option value="2">Executable</option><option value="0">Shared Library</option><option value="1">Shellcode</option><option value="3">Service</option></select>
    </div>
  </div>

  <div class="check"><input type="checkbox" id="external" /><label style="margin:0">Build on an external builder</label></div>
  <div id="external-fields" class="hidden">
    <label>Builder</label>
    <select id="builder"><option value="">— no builders registered —</option></select>
    <div class="hint">Hands the build to a registered builder (e.g. tsh-builder). The binary is compiled asynchronously — when it's done, download it from Server → Implant Builds. “Save as Profile” is unaffected.</div>
  </div>

  <h3>Command &amp; Control</h3>
  <label>Add C2 from a running listener</label>
  <select id="listeners"><option value="">— select a listener —</option></select>
  <label>C2 URLs (one per line, in priority order)</label>
  <div class="chips">
    <button type="button" class="chip" data-tpl="mtls://HOST:8888">+ mtls</button>
    <button type="button" class="chip" data-tpl="https://HOST:443">+ https</button>
    <button type="button" class="chip" data-tpl="http://HOST:80">+ http</button>
    <button type="button" class="chip" data-tpl="dns://example.com">+ dns</button>
    <button type="button" class="chip" data-tpl="wg://HOST:53">+ wg</button>
    <button type="button" class="chip" data-tpl="tcp-pivot://HOST:9898">+ tcp-pivot</button>
    <button type="button" class="chip" data-tpl="namedpipe://./pipe/NAME">+ named-pipe</button>
  </div>
  <textarea id="c2" placeholder="mtls://192.168.1.10:8888"></textarea>
  <div class="hint">tcp-pivot / named-pipe route through an existing session (set up a pivot listener on it first). Priority follows line order.</div>

  <details id="c2advWrap">
    <summary>Advanced C2 options (per-endpoint ?query)</summary>
    <div class="optbox">
      <label>Apply options to which C2 line?</label>
      <select id="c2target"></select>
      <div class="hint">Edit the fields, then “Apply to selected line” appends them as a <code>?query</code> string. Only valid for http/https (and DNS where noted). Blank = unchanged.</div>

      <h4>HTTP / HTTPS</h4>
      <div class="optgrid">
        <div><label>driver</label>
          <select id="o_driver"><option value="">(default)</option><option value="go">go</option><option value="wininet">wininet (Windows)</option><option value="__custom__">Custom…</option></select>
          <input id="o_driverCustom" class="hidden" placeholder="custom driver name" style="margin-top:6px" /></div>
        <div><label>host-header (domain fronting)</label><input id="o_hosthdr" placeholder="cdn.example.com" /></div>
        <div><label>proxy URL</label><input id="o_proxy" placeholder="http://proxy:8080" /></div>
        <div><label>proxy username</label><input id="o_proxyuser" /></div>
        <div><label>proxy password</label><input id="o_proxypass" /></div>
        <div><label>net-timeout (e.g. 60s)</label><input id="o_nettimeout" placeholder="60s" /></div>
        <div><label>tls-timeout (e.g. 30s)</label><input id="o_tlstimeout" placeholder="30s" /></div>
        <div><label>poll-timeout (e.g. 360s)</label><input id="o_polltimeout" placeholder="360s" /></div>
        <div><label>max-errors</label><input id="o_maxerrors" type="number" min="0" placeholder="10" /></div>
      </div>
      <div class="check"><input type="checkbox" id="o_forcehttp" /><label style="margin:0">force-http (plaintext even on https scheme)</label></div>
      <div class="check"><input type="checkbox" id="o_noaccept" /><label style="margin:0">disable-accept-header</label></div>
      <div class="check"><input type="checkbox" id="o_noupgrade" /><label style="margin:0">disable-upgrade-header</label></div>
      <div class="check"><input type="checkbox" id="o_askproxy" /><label style="margin:0">ask-proxy-creds (wininet prompt)</label></div>

      <h4>DNS</h4>
      <div class="optgrid">
        <div><label>resolvers (a+b)</label><input id="o_resolvers" placeholder="1.1.1.1+8.8.8.8" /></div>
        <div><label>timeout</label><input id="o_dnstimeout" placeholder="30s" /></div>
        <div><label>retry-count</label><input id="o_retrycount" type="number" min="0" placeholder="3" /></div>
        <div><label>retry-wait</label><input id="o_retrywait" placeholder="1s" /></div>
        <div><label>workers-per-resolver</label><input id="o_workers" type="number" min="0" placeholder="2" /></div>
      </div>
      <div class="check"><input type="checkbox" id="o_forceresolv" /><label style="margin:0">force-resolv-conf (use system resolv.conf)</label></div>

      <button type="button" class="chip" id="applyOpts" style="margin-top:10px">Apply to selected line</button>
    </div>
  </details>

  <label>HTTP C2 profile (URL paths, extensions, user-agent, headers)</label>
  <select id="c2profile"><option value="default">default</option></select>
  <div class="hint">Pick a profile to vary the HTTP request paths/filenames. Create/edit profiles under Server → HTTP-C2 Profiles.</div>

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

  <details>
    <summary>Advanced options</summary>

    <div class="row">
      <div><label>HTTP poll timeout (s)</label><input id="pollTimeoutSec" type="number" value="360" min="0" /></div>
      <div><label>Connection strategy</label>
        <select id="connStrategy">
          <option value="">Sequential (default)</option>
          <option value="s">Sequential</option>
          <option value="r">Random</option>
          <option value="rd">Random domain</option>
        </select>
      </div>
    </div>

    <div class="check"><input type="checkbox" id="evasion" /><label style="margin:0">Evasion (extra anti-analysis at build)</label></div>
    <div class="check"><input type="checkbox" id="netgo" /><label style="margin:0">NetGo (pure-Go networking, no libc)</label></div>
    <div class="check"><input type="checkbox" id="disableSgn" /><label style="margin:0">Disable SGN encoder (shellcode only)</label></div>

    <label>Traffic encoders (wasm) — ctrl/cmd-click to multi-select</label>
    <select id="trafficEncoders" multiple></select>

    <label>Canary domains (one per line — DNS canary tokens)</label>
    <textarea id="canaryDomains" placeholder="canary.example.com"></textarea>

    <h3>Execution constraints</h3>
    <div class="hint">Implant exits unless every set condition is met on the target.</div>
    <div class="row">
      <div><label>Limit hostname</label><input id="limitHostname" placeholder="WIN-ABC" /></div>
      <div><label>Limit username</label><input id="limitUsername" placeholder="alice" /></div>
    </div>
    <div class="row">
      <div><label>Limit datetime (not-after)</label><input id="limitDatetime" placeholder="2026-12-31 23:59:59" /></div>
      <div><label>Limit locale</label><input id="limitLocale" placeholder="en_US" /></div>
    </div>
    <label>Limit file exists (path)</label>
    <input id="limitFileExists" placeholder="C:\\Windows\\System32\\target.dll" />
    <div class="check"><input type="checkbox" id="limitDomainJoined" /><label style="margin:0">Only run on a domain-joined host</label></div>

    <label>Debug log file (on target)</label>
    <input id="debugFile" placeholder="leave blank for none" />
  </details>

  <button id="go">Generate</button>
  <button id="saveProfile" style="background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff);">Save as Profile</button>
  <div id="status"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let pendingForm = null;
  const setVal = (id, v) => { const el = $(id); if (el) el.value = (v == null ? '' : v); };
  const setChk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  const applyEncoders = (list) => { const sel = $('trafficEncoders'); if (!sel) return; const want = new Set(list || []); Array.from(sel.options).forEach((o) => { o.selected = want.has(o.value); }); };
  function applyForm(f) {
    setVal('name', f.name); setVal('goos', f.goos); setVal('goarch', f.goarch); setVal('format', String(f.format));
    setChk('isBeacon', f.isBeacon);
    setVal('beaconIntervalSec', f.beaconIntervalSec); setVal('beaconJitterSec', f.beaconJitterSec);
    setVal('reconnectSec', f.reconnectSec); setVal('maxErrors', f.maxErrors);
    setVal('c2', f.c2); setChk('obfuscate', f.obfuscate); setChk('runAtLoad', f.runAtLoad); setChk('debug', f.debug);
    setVal('c2profile', f.c2profile);
    setVal('pollTimeoutSec', f.pollTimeoutSec); setVal('connStrategy', f.connStrategy);
    setChk('evasion', f.evasion); setChk('netgo', f.netgo); setChk('disableSgn', f.disableSgn);
    applyEncoders(f.trafficEncoders);
    setVal('canaryDomains', f.canaryDomains);
    setVal('limitHostname', f.limitHostname); setVal('limitUsername', f.limitUsername);
    setVal('limitDatetime', f.limitDatetime); setVal('limitFileExists', f.limitFileExists);
    setVal('limitLocale', f.limitLocale); setChk('limitDomainJoined', f.limitDomainJoined);
    setVal('debugFile', f.debugFile);
  }
  function setEditMode(name) {
    if (name) { $('editName').textContent = name; $('editBanner').classList.remove('hidden'); $('saveProfile').textContent = 'Save Profile'; }
    else { $('editBanner').classList.add('hidden'); $('saveProfile').textContent = 'Save as Profile'; }
  }
  const c2lines = () => $('c2').value.split('\\n').map((s) => s.trim()).filter(Boolean);
  const appendC2 = (url) => { const ta = $('c2'); ta.value = (ta.value ? ta.value.replace(/\\s*$/, '') + '\\n' : '') + url; refreshC2Targets(); };
  $('listeners').addEventListener('change', (e) => { if (e.target.value) { appendC2(e.target.value); e.target.value = ''; } });
  // Scheme insert buttons.
  document.querySelectorAll('.chip[data-tpl]').forEach((b) => b.addEventListener('click', () => appendC2(b.getAttribute('data-tpl'))));
  // Keep the "apply options to which line" dropdown in sync with the C2 textarea.
  function refreshC2Targets() {
    const sel = $('c2target'); if (!sel) return;
    const prev = sel.value;
    const lines = c2lines();
    sel.innerHTML = lines.map((l, i) => '<option value="' + i + '">' + l.replace(/</g, '&lt;') + '</option>').join('') || '<option value="">(add a C2 URL first)</option>';
    if (prev && lines[prev]) sel.value = prev;
  }
  $('c2').addEventListener('input', refreshC2Targets);
  // Driver 'Custom…' reveals a free-text driver name input.
  $('o_driver').addEventListener('change', () => {
    $('o_driverCustom').classList.toggle('hidden', $('o_driver').value !== '__custom__');
    if ($('o_driver').value === '__custom__') $('o_driverCustom').focus();
  });
  // Build a ?query from the advanced-option fields and merge it into the chosen C2 line.
  $('applyOpts').addEventListener('click', () => {
    const idx = parseInt($('c2target').value, 10);
    const lines = c2lines();
    if (isNaN(idx) || !lines[idx]) { return; }
    const pairs = [];
    const addv = (k, id) => { const v = $(id).value.trim(); if (v) pairs.push([k, v]); };
    const addc = (k, id) => { if ($(id).checked) pairs.push([k, 'true']); };
    // driver: 'Custom…' takes the free-text value; presets use their own value.
    const driverVal = $('o_driver').value === '__custom__' ? $('o_driverCustom').value.trim() : $('o_driver').value.trim();
    if (driverVal) pairs.push(['driver', driverVal]);
    addv('host-header', 'o_hosthdr');
    addv('proxy', 'o_proxy'); addv('proxy-username', 'o_proxyuser'); addv('proxy-password', 'o_proxypass');
    addv('net-timeout', 'o_nettimeout'); addv('tls-timeout', 'o_tlstimeout'); addv('poll-timeout', 'o_polltimeout'); addv('max-errors', 'o_maxerrors');
    addc('force-http', 'o_forcehttp'); addc('disable-accept-header', 'o_noaccept'); addc('disable-upgrade-header', 'o_noupgrade'); addc('ask-proxy-creds', 'o_askproxy');
    addv('resolvers', 'o_resolvers'); addv('timeout', 'o_dnstimeout'); addv('retry-count', 'o_retrycount'); addv('retry-wait', 'o_retrywait'); addv('workers-per-resolver', 'o_workers');
    addc('force-resolv-conf', 'o_forceresolv');
    // Rebuild the URL: keep base, replace query with the assembled options.
    let base = lines[idx], existingQ = '';
    const qpos = base.indexOf('?');
    if (qpos >= 0) { existingQ = base.slice(qpos + 1); base = base.slice(0, qpos); }
    const params = new URLSearchParams(existingQ);
    pairs.forEach(([k, v]) => params.set(k, v));
    // Keep the percent-encoded form: the implant reads options with Go's
    // url.Query().Get(), so '+' must stay %2B (DNS resolver separator) and
    // '&'/'=' in values must stay encoded. Do NOT decodeURIComponent here.
    const qs = params.toString();
    lines[idx] = qs ? base + '?' + qs : base;
    $('c2').value = lines.join('\\n');
    refreshC2Targets();
    const s = $('status'); s.textContent = 'Applied options to: ' + lines[idx]; s.className = 'ok';
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
    c2profile: $('c2profile').value,
    pollTimeoutSec: parseInt($('pollTimeoutSec').value, 10) || 0,
    connStrategy: $('connStrategy').value,
    evasion: $('evasion').checked, netgo: $('netgo').checked, disableSgn: $('disableSgn').checked,
    trafficEncoders: Array.from($('trafficEncoders').selectedOptions).map((o) => o.value),
    canaryDomains: $('canaryDomains').value,
    limitHostname: $('limitHostname').value, limitUsername: $('limitUsername').value,
    limitDatetime: $('limitDatetime').value, limitFileExists: $('limitFileExists').value,
    limitLocale: $('limitLocale').value, limitDomainJoined: $('limitDomainJoined').checked,
    debugFile: $('debugFile').value,
    external: $('external').checked, builder: $('builder').value,
  });
  $('external').addEventListener('change', () => {
    $('external-fields').classList.toggle('hidden', !$('external').checked);
    // External builders compile their own artifact; the local Save dialog won't run.
    $('go').textContent = $('external').checked ? 'Dispatch to Builder' : 'Generate';
  });
  $('go').addEventListener('click', () => vscode.postMessage({ type: 'generate', form: readForm() }));
  $('saveProfile').addEventListener('click', () => vscode.postMessage({ type: 'saveProfile', form: readForm() }));
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'status') { const s = $('status'); s.textContent = m.text; s.className = m.kind || ''; }
    else if (m.type === 'busy') {
      $('go').disabled = m.busy;
      const ext = $('external').checked;
      $('go').textContent = m.busy ? (ext ? 'Dispatching…' : 'Building…') : (ext ? 'Dispatch to Builder' : 'Generate');
    }
    else if (m.type === 'listeners') {
      const sel = $('listeners');
      sel.innerHTML = '<option value="">— select a listener —</option>' + m.suggestions.map((s) => '<option value="' + s.url + '">' + s.label + '</option>').join('');
    }
    else if (m.type === 'builders') {
      const sel = $('builder');
      if (!m.builders.length) { sel.innerHTML = '<option value="">— no builders registered —</option>'; }
      else { sel.innerHTML = m.builders.map((b) => '<option value="' + b.name + '">' + b.label + '</option>').join(''); }
    }
    else if (m.type === 'c2profiles') {
      const sel = $('c2profile'); const prev = (pendingForm && pendingForm.c2profile) || sel.value || 'default';
      sel.innerHTML = m.names.map((n) => '<option' + (n === prev ? ' selected' : '') + '>' + n + '</option>').join('');
    }
    else if (m.type === 'encoders') {
      $('trafficEncoders').innerHTML = m.names.map((n) => '<option>' + n + '</option>').join('');
      if (pendingForm) applyEncoders(pendingForm.trafficEncoders);
    }
    else if (m.type === 'init') { pendingForm = m.form; applyForm(m.form); setEditMode(m.editProfile); refreshC2Targets(); }
    else if (m.type === 'resetProfileMode') { pendingForm = null; setEditMode(null); }
  });
  refreshC2Targets();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
