import * as vscode from 'vscode';
import * as zlib from 'node:zlib';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConnectionManager } from '../client/ConnectionManager';
import { sliverUri } from '../fs/SliverFileSystemProvider';
import { Execute } from '../grpc/sliverpb/sliver';
import { friendlyError, requireActive, showText, resolveSession, pickProcess, Node } from './helpers';

export function registerTier1(connections: ConnectionManager): vscode.Disposable[] {
  const reg = (id: string, fn: (...a: any[]) => any) => vscode.commands.registerCommand(id, fn);
  const active = () => requireActive(connections);

  return [
    // --- File system --------------------------------------------------
    reg('sliver.session.browseFiles', async (node?: Node) => {
      if (!active()) {
        return;
      }
      const session = await resolveSession(connections, node);
      if (!session) {
        return;
      }
      const uri = sliverUri(session.ID, '/');
      const name = `Sliver: ${session.Name || session.Hostname}`;
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (!folders.some((f) => f.uri.authority === session.ID)) {
        vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name });
      }
      void vscode.commands.executeCommand('workbench.view.explorer');
    }),

    reg('sliver.session.download', async (node?: Node) => {
      const client = active();
      if (!client) {
        return;
      }
      const session = await resolveSession(connections, node);
      if (!session) {
        return;
      }
      const remote = await vscode.window.showInputBox({ prompt: 'Remote file path to download' });
      if (!remote) {
        return;
      }
      try {
        const dl = await client.download({ Path: remote, Request: { SessionID: session.ID, Timeout: '120' } });
        if (!dl.Exists) {
          void vscode.window.showErrorMessage(`Not found: ${remote}`);
          return;
        }
        const bytes = /gzip/i.test(dl.Encoder) ? zlib.gunzipSync(Buffer.from(dl.Data)) : Buffer.from(dl.Data);
        const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.basename(remote)) });
        if (dest) {
          await vscode.workspace.fs.writeFile(dest, new Uint8Array(bytes));
          void vscode.window.showInformationMessage(`Downloaded ${bytes.length} bytes → ${dest.fsPath}`);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Download failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.upload', async (node?: Node) => {
      const client = active();
      if (!client) {
        return;
      }
      const session = await resolveSession(connections, node);
      if (!session) {
        return;
      }
      const src = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Upload' });
      if (!src?.length) {
        return;
      }
      const data = Buffer.from(await vscode.workspace.fs.readFile(src[0]));
      const remote = await vscode.window.showInputBox({
        prompt: 'Remote destination path',
        value: `/tmp/${path.basename(src[0].fsPath)}`,
      });
      if (!remote) {
        return;
      }
      try {
        await client.upload({
          Path: remote,
          Data: zlib.gzipSync(data),
          Encoder: 'gzip',
          Overwrite: true,
          Request: { SessionID: session.ID, Timeout: '120' },
        });
        void vscode.window.showInformationMessage(`Uploaded ${data.length} bytes → ${remote}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Upload failed: ${friendlyError(err)}`);
      }
    }),

    // --- Screenshot ---------------------------------------------------
    reg('sliver.session.screenshot', async (node?: Node) => {
      const client = active();
      if (!client) {
        return;
      }
      const session = await resolveSession(connections, node);
      if (!session) {
        return;
      }
      try {
        const shot = await client.screenshot(session.ID);
        if (!shot.Data?.length) {
          void vscode.window.showWarningMessage('Screenshot returned no data.');
          return;
        }
        const file = vscode.Uri.file(path.join(os.tmpdir(), `sliver-${session.ID.slice(0, 8)}-${Date.now()}.png`));
        await vscode.workspace.fs.writeFile(file, new Uint8Array(Buffer.from(shot.Data)));
        await vscode.commands.executeCommand('vscode.open', file);
      } catch (err) {
        void vscode.window.showErrorMessage(`Screenshot failed: ${friendlyError(err)}`);
      }
    }),

    // --- Recon --------------------------------------------------------
    reg('sliver.session.ifconfig', async (node?: Node) => {
      const client = active();
      if (!client) {
        return;
      }
      const s = await resolveSession(connections, node);
      if (!s) {
        return;
      }
      try {
        const r = await client.ifconfig(s.ID);
        await showText(JSON.stringify(r.NetInterfaces ?? r, null, 2), 'json');
      } catch (err) {
        void vscode.window.showErrorMessage(`ifconfig failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.netstat', async (node?: Node) => {
      const client = active();
      if (!client) {
        return;
      }
      const s = await resolveSession(connections, node);
      if (!s) {
        return;
      }
      try {
        const r = await client.netstat({
          TCP: true,
          UDP: true,
          Listening: true,
          IP4: true,
          IP6: true,
          Request: { SessionID: s.ID },
        });
        const lines = (r.Entries ?? []).map(
          (e: any) => `${e.Protocol}\t${e.LocalAddr?.Ip}:${e.LocalAddr?.Port}\t${e.RemoteAddr?.Ip}:${e.RemoteAddr?.Port}\t${e.SkState}\t${e.Process?.Executable ?? ''}`,
        );
        await showText(['Proto\tLocal\tRemote\tState\tProcess', ...lines].join('\n'));
      } catch (err) {
        void vscode.window.showErrorMessage(`netstat failed: ${friendlyError(err)}`);
      }
    }),

    // --- Process control ----------------------------------------------
    reg('sliver.session.killProcess', async (node?: Node) => {
      const client = active();
      if (!client) {
        return;
      }
      const s = await resolveSession(connections, node);
      if (!s) {
        return;
      }
      const pid = await pickProcess(client, s.ID, 'Process to terminate');
      if (pid === undefined) {
        return;
      }
      try {
        await client.terminate({ Pid: pid, Force: true, Request: { SessionID: s.ID } });
        void vscode.window.showInformationMessage(`Terminated PID ${pid}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Terminate failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.procdump', async (node?: Node) => {
      const client = active();
      if (!client) {
        return;
      }
      const s = await resolveSession(connections, node);
      if (!s) {
        return;
      }
      const pid = await pickProcess(client, s.ID, 'Process to dump');
      if (pid === undefined) {
        return;
      }
      try {
        const dump = await client.processDump({ Pid: pid, Request: { SessionID: s.ID, Timeout: '120' } });
        const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`procdump-${pid}.bin`) });
        if (dest) {
          await vscode.workspace.fs.writeFile(dest, new Uint8Array(Buffer.from(dump.Data)));
          void vscode.window.showInformationMessage(`Dumped PID ${pid} → ${dest.fsPath}`);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Procdump failed: ${friendlyError(err)}`);
      }
    }),

    // --- Env / services -----------------------------------------------
    reg('sliver.session.getenv', async (node?: Node) => {
      const client = active();
      if (!client) {
        return;
      }
      const s = await resolveSession(connections, node);
      if (!s) {
        return;
      }
      try {
        const r = await client.getEnv({ Name: '', Request: { SessionID: s.ID } });
        await showText((r.Variables ?? []).map((v: any) => `${v.Key}=${v.Value}`).join('\n') || '(empty)');
      } catch (err) {
        void vscode.window.showErrorMessage(`getenv failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.services', async (node?: Node) => {
      const client = active();
      if (!client) {
        return;
      }
      const s = await resolveSession(connections, node);
      if (!s) {
        return;
      }
      try {
        const r = await client.services({ Hostname: '', Request: { SessionID: s.ID } });
        await showText(JSON.stringify(r.Details ?? r, null, 2), 'json');
      } catch (err) {
        void vscode.window.showErrorMessage(`services failed: ${friendlyError(err)}`);
      }
    }),

    // --- Session / beacon management ----------------------------------
    reg('sliver.session.rename', async (node?: Node) => {
      const client = active();
      if (!client || !node?.session) {
        return;
      }
      const name = await vscode.window.showInputBox({ prompt: 'New session name', value: node.session.Name });
      if (name) {
        await client.rename({ SessionID: node.session.ID, Name: name });
        void vscode.commands.executeCommand('sliver.refresh');
      }
    }),

    reg('sliver.beacon.rename', async (node?: Node) => {
      const client = active();
      if (!client || !node?.beacon) {
        return;
      }
      const name = await vscode.window.showInputBox({ prompt: 'New beacon name', value: node.beacon.Name });
      if (name) {
        await client.rename({ BeaconID: node.beacon.ID, Name: name });
        void vscode.commands.executeCommand('sliver.refresh');
      }
    }),

    reg('sliver.beacon.remove', async (node?: Node) => {
      const client = active();
      if (!client || !node?.beacon) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Remove beacon ${node.beacon.Name}?`,
        { modal: true },
        'Remove',
      );
      if (ok === 'Remove') {
        await client.rmBeacon(node.beacon.ID);
        void vscode.commands.executeCommand('sliver.refresh');
      }
    }),

    reg('sliver.beacon.taskContent', async (node?: Node) => {
      const client = active();
      if (!client || !node?.beacon) {
        return;
      }
      const { Tasks } = await client.getBeaconTasks(node.beacon.ID);
      const pick = await vscode.window.showQuickPick(
        Tasks.map((t) => ({ label: t.Description, description: `${t.State} ${t.ID.slice(0, 8)}`, id: t.ID })),
        { placeHolder: 'Select a task to view' },
      );
      if (!pick) {
        return;
      }
      const full = await client.getBeaconTaskContent(pick.id);
      const header = `Task ${full.ID}\nState: ${full.State}   Type: ${full.Description}\n${'─'.repeat(48)}\n`;
      let body = '';
      // The Response is a protobuf-encoded result. Most tasks are Execute —
      // decode it to show real stdout/stderr; fall back to a note otherwise.
      try {
        if (full.Response && full.Response.length) {
          const exec = Execute.decode(full.Response);
          const out = Buffer.from(exec.Stdout ?? []).toString('utf8');
          const err = Buffer.from(exec.Stderr ?? []).toString('utf8');
          body = [out, err].filter(Boolean).join('\n') || `(exit ${exec.Status}, no output)`;
        } else {
          body = '(no response yet — task not completed)';
        }
      } catch {
        body = `(binary response, ${full.Response?.length ?? 0} bytes — not an Execute result)`;
      }
      await showText(header + body);
    }),
  ];
}
