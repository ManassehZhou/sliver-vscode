import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';
import { ServerItemNode } from '../ui/ServerTree';
import { friendlyError, requireActive, showText, resolveSession, Node } from './helpers';

const MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', js: 'application/javascript', css: 'text/css',
  json: 'application/json', txt: 'text/plain', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  pdf: 'application/pdf', zip: 'application/zip', exe: 'application/vnd.microsoft.portable-executable',
  dll: 'application/x-msdownload', ps1: 'text/plain', sh: 'text/x-shellscript',
};

function guessContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

export function registerTier3(connections: ConnectionManager, refreshServer: () => void): vscode.Disposable[] {
  const reg = (id: string, fn: (...a: any[]) => any) => vscode.commands.registerCommand(id, fn);
  const active = () => requireActive(connections);

  return [
    reg('sliver.server.refresh', () => refreshServer()),

    // --- Advanced server-level read-only listings (Tier J) ------------
    reg('sliver.server.certInfo', async () => {
      const c = active();
      if (!c) {
        return;
      }
      try {
        const r = await c.getCertificateInfo({ CategoryFilters: 0, CN: '' });
        await showText(JSON.stringify(r.Info ?? r, null, 2), 'json');
      } catch (e) {
        void vscode.window.showErrorMessage(`cert info failed: ${friendlyError(e)}`);
      }
    }),
    reg('sliver.server.crackstations', async () => {
      const c = active();
      if (!c) {
        return;
      }
      try {
        const r = await c.crackstations();
        await showText(JSON.stringify(r.Crackstations ?? r, null, 2), 'json');
      } catch (e) {
        void vscode.window.showErrorMessage(`crackstations failed: ${friendlyError(e)}`);
      }
    }),
    reg('sliver.server.builders', async () => {
      const c = active();
      if (!c) {
        return;
      }
      try {
        const r = await c.builders();
        await showText(JSON.stringify(r.Builders ?? r, null, 2), 'json');
      } catch (e) {
        void vscode.window.showErrorMessage(`builders failed: ${friendlyError(e)}`);
      }
    }),
    reg('sliver.server.encoders', async () => {
      const c = active();
      if (!c) {
        return;
      }
      try {
        const r = await c.trafficEncoderMap();
        await showText(JSON.stringify(r.Encoders ?? r, null, 2), 'json');
      } catch (e) {
        void vscode.window.showErrorMessage(`encoders failed: ${friendlyError(e)}`);
      }
    }),

    // --- Loot / hosts / creds -----------------------------------------
    reg('sliver.loot.delete', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      await client.lootRm(node.value);
      refreshServer();
    }),

    reg('sliver.host.delete', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      await client.hostRm(node.value);
      refreshServer();
    }),

    // --- Implant builds / profiles ------------------------------------
    reg('sliver.build.regenerate', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      try {
        const g = await client.regenerate(node.value);
        if (!g.File) {
          void vscode.window.showWarningMessage('No build returned.');
          return;
        }
        const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(g.File.Name || node.value) });
        if (dest) {
          await vscode.workspace.fs.writeFile(dest, new Uint8Array(Buffer.from(g.File.Data)));
          void vscode.window.showInformationMessage(`Regenerated ${node.value} → ${dest.fsPath}`);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Regenerate failed: ${friendlyError(err)}`);
      }
    }),

    reg('sliver.build.delete', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      await client.deleteImplantBuild(node.value);
      refreshServer();
    }),

    reg('sliver.profile.delete', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      await client.deleteImplantProfile(node.value);
      refreshServer();
    }),

    reg('sliver.website.delete', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      await client.websiteRemove(node.value);
      refreshServer();
    }),

    // --- Threat monitoring --------------------------------------------
    reg('sliver.monitor.start', async () => {
      const client = active();
      if (!client) {
        return;
      }
      await client.monitorStart();
      void vscode.window.showInformationMessage('Threat monitoring started.');
    }),

    reg('sliver.monitor.stop', async () => {
      const client = active();
      if (!client) {
        return;
      }
      await client.monitorStop();
      void vscode.window.showInformationMessage('Threat monitoring stopped.');
    }),

    // --- Credentials ---------------------------------------------------
    reg('sliver.cred.delete', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      await client.credsRm([{ ID: node.value }]);
      refreshServer();
    }),

    reg('sliver.cred.copyUsername', async (node?: ServerItemNode) => {
      const username = node?.data?.Username ?? '';
      await vscode.env.clipboard.writeText(username);
      void vscode.window.showInformationMessage(`Copied username: ${username || '(empty)'}`);
    }),

    reg('sliver.cred.copyPassword', async (node?: ServerItemNode) => {
      const secret = node?.data?.Plaintext || node?.data?.Hash || '';
      await vscode.env.clipboard.writeText(secret);
      void vscode.window.showInformationMessage(secret ? 'Copied password/hash to clipboard.' : 'No secret to copy.');
    }),

    reg('sliver.creds.add', async () => {
      const client = active();
      if (!client) {
        return;
      }
      const username = await vscode.window.showInputBox({ prompt: 'Username' });
      if (!username) {
        return;
      }
      const secret = await vscode.window.showInputBox({ prompt: 'Plaintext password or hash' });
      if (secret === undefined) {
        return;
      }
      const isHash = await vscode.window.showQuickPick(['Plaintext', 'Hash'], { placeHolder: 'Secret type' });
      try {
        await client.credsAdd([
          isHash === 'Hash'
            ? { Username: username, Hash: secret, Collection: 'vscode' }
            : { Username: username, Plaintext: secret, IsCracked: true, Collection: 'vscode' },
        ]);
        refreshServer();
      } catch (err) {
        void vscode.window.showErrorMessage(`Add credential failed: ${friendlyError(err)}`);
      }
    }),

    // --- Loot ----------------------------------------------------------
    reg('sliver.loot.download', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      try {
        const loot = await client.lootContent(node.value);
        if (!loot.File?.Data) {
          void vscode.window.showWarningMessage('Loot has no file content.');
          return;
        }
        const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(loot.File.Name || loot.Name || 'loot') });
        if (dest) {
          await vscode.workspace.fs.writeFile(dest, new Uint8Array(Buffer.from(loot.File.Data)));
          void vscode.window.showInformationMessage(`Loot saved → ${dest.fsPath}`);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Download loot failed: ${friendlyError(err)}`);
      }
    }),

    // --- Profiles: generate an implant from a saved profile -----------
    reg('sliver.profile.generate', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      try {
        const { Profiles } = await client.implantProfiles();
        const profile = Profiles.find((p: any) => p.Name === node.value);
        if (!profile?.Config) {
          void vscode.window.showErrorMessage(`Profile "${node.value}" has no config.`);
          return;
        }
        const name = await vscode.window.showInputBox({ prompt: 'Implant name (blank = random)' });
        if (name === undefined) {
          return;
        }
        const g = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Building from profile "${node.value}"…` },
          () => client.generate({ Name: name, Config: { ...profile.Config, Name: name } }),
        );
        if (!g.File) {
          return;
        }
        const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(g.File.Name || name || 'implant') });
        if (dest) {
          await vscode.workspace.fs.writeFile(dest, new Uint8Array(Buffer.from(g.File.Data)));
          void vscode.window.showInformationMessage(`Built "${g.File.Name}" → ${dest.fsPath}`);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Generate from profile failed: ${friendlyError(err)}`);
      }
    }),

    // --- Loot: add a file as loot -------------------------------------
    reg('sliver.loot.add', async () => {
      const client = active();
      if (!client) {
        return;
      }
      const file = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Add as loot' });
      if (!file?.length) {
        return;
      }
      const name = await vscode.window.showInputBox({ prompt: 'Loot name', value: file[0].path.split('/').pop() });
      if (!name) {
        return;
      }
      const data = Buffer.from(await vscode.workspace.fs.readFile(file[0]));
      try {
        await client.lootAdd({ Name: name, FileType: 1, File: { Name: name, Data: data } });
        refreshServer();
      } catch (err) {
        void vscode.window.showErrorMessage(`Add loot failed: ${friendlyError(err)}`);
      }
    }),

    // --- Hosts: show details + IOCs -----------------------------------
    reg('sliver.host.details', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      try {
        const host = await client.host(node.value);
        await showText(JSON.stringify(host, null, 2), 'json');
      } catch (err) {
        void vscode.window.showErrorMessage(`Host details failed: ${friendlyError(err)}`);
      }
    }),

    // --- Websites: add content (creates the site if new) --------------
    reg('sliver.website.addContent', async (node?: ServerItemNode) => {
      const client = active();
      if (!client) {
        return;
      }
      const name = node?.value ?? (await vscode.window.showInputBox({ prompt: 'Website name (new or existing)' }));
      if (!name) {
        return;
      }
      const file = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Host this file' });
      if (!file?.length) {
        return;
      }
      const filename = file[0].path.split('/').pop() ?? 'file';
      const webPath = await vscode.window.showInputBox({ prompt: 'URL path to serve it at', value: '/' + filename });
      if (!webPath) {
        return;
      }
      // Default the content-type from the file extension; let the operator override.
      const contentType =
        (await vscode.window.showInputBox({ prompt: 'Content-Type', value: guessContentType(filename) })) ??
        'application/octet-stream';
      const data = Buffer.from(await vscode.workspace.fs.readFile(file[0]));
      try {
        await client.websiteAddContent({
          Name: name,
          Contents: {
            [webPath]: { Path: webPath, ContentType: contentType, Content: data, OriginalFile: filename, Size: String(data.length) },
          },
        });
        void vscode.window.showInformationMessage(`Hosting ${webPath} on website "${name}"`);
        refreshServer();
      } catch (err) {
        void vscode.window.showErrorMessage(`Add content failed: ${friendlyError(err)}`);
      }
    }),

    // --- Session extensions -------------------------------------------
    reg('sliver.session.listExtensions', async (node?: Node) => {
      const client = active();
      const s = client && (await resolveSession(connections, node));
      if (!client || !s) {
        return;
      }
      try {
        const r = await client.listExtensions(s.ID);
        await showText(JSON.stringify(r.Names ?? r, null, 2), 'json');
      } catch (err) {
        void vscode.window.showErrorMessage(`list-extensions failed: ${friendlyError(err)}`);
      }
    }),
  ];
}
