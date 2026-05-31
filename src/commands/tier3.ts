import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';
import { ServerItemNode } from '../ui/ServerTree';
import { friendlyError, requireActive, showText, resolveSession, Node } from './helpers';
import { GeneratePanel } from '../webview/GeneratePanel';
import { C2ProfilePanel } from '../webview/C2ProfilePanel';

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

/** Human-readable view of an HTTP C2 profile (paths/extensions/UA) + the raw proto JSON. */
function summarizeHttpC2Profile(p: any): string {
  const impl = p.ImplantConfig ?? {};
  const srv = p.ServerConfig ?? {};
  const segs: any[] = impl.PathSegments ?? [];
  const dirs = segs.filter((s) => !s.IsFile).map((s) => s.Value);
  const files = segs.filter((s) => s.IsFile).map((s) => s.Value);
  const exts: string[] = impl.extensions ?? [];
  return [
    `# HTTP C2 profile: ${p.Name}`,
    '',
    `User-Agent: ${impl.UserAgent || '(randomized Chrome)'}`,
    `Path length: ${impl.MinPathLength}–${impl.MaxPathLength}    dirs/url: ${impl.MinPathGen}–${impl.MaxPathGen}    files/url: ${impl.MinFileGen}–${impl.MaxFileGen}`,
    `Nonce: mode=${impl.NonceMode || '-'} len=${impl.NonceQueryLength ?? '-'} chars=${impl.NonceQueryArgChars || '-'}`,
    '',
    `Extensions (${exts.length}): ${exts.join(', ') || '—'}`,
    `Directory segments (${dirs.length}): ${dirs.join(', ') || '—'}`,
    `Filename segments (${files.length}): ${files.join(', ') || '—'}`,
    '',
    `Server: random-version-headers=${!!srv.RandomVersionHeaders}  headers=${(srv.Headers ?? []).length}  cookies=${(srv.Cookies ?? []).length}`,
    '',
    '--- raw HTTPC2Config (edit the paths/Name and re-import to create a variant) ---',
    JSON.stringify(p, null, 2),
  ].join('\n');
}

/** Recursively drop `ID` keys so a cloned config saves as a new row, not an update. */
function stripIds(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(stripIds);
  }
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'ID') {
        continue;
      }
      out[k] = stripIds(v);
    }
    return out;
  }
  return obj;
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
    reg('sliver.server.httpC2Profiles', async () => {
      const c = active();
      if (!c) {
        return;
      }
      const NEW = '__new__';
      const IMPORT = '__import__';
      try {
        const r = await c.getHttpC2Profiles();
        const profiles: any[] = r.configs ?? [];
        const items: (vscode.QuickPickItem & { name: string })[] = [
          ...profiles.map((p) => ({
            label: `$(edit) ${p.Name}`,
            description: `${(p.ImplantConfig?.PathSegments ?? []).length} segments · ${(p.ImplantConfig?.extensions ?? []).length} ext`,
            name: p.Name,
          })),
          { label: '$(add) New profile…', name: NEW, alwaysShow: true },
          { label: '$(cloud-upload) Import profile from JSON file…', name: IMPORT, alwaysShow: true },
        ];
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'HTTP-C2 profile — pick to edit, or create one' });
        if (!pick) {
          return;
        }
        if (pick.name === IMPORT) {
          const file = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Import C2 profile' });
          if (!file?.length) {
            return;
          }
          const raw = Buffer.from(await vscode.workspace.fs.readFile(file[0])).toString('utf8');
          let cfg: any;
          try {
            cfg = JSON.parse(raw);
          } catch {
            void vscode.window.showErrorMessage('Selected file is not valid JSON.');
            return;
          }
          if (!cfg.Name) {
            const name = await vscode.window.showInputBox({ prompt: 'Profile name' });
            if (!name) {
              return;
            }
            cfg.Name = name;
          }
          // overwrite=true updates an existing profile; false creates a new one.
          const exists = profiles.some((p) => p.Name === cfg.Name);
          await c.saveHttpC2Profile(cfg, exists);
          void vscode.window.showInformationMessage(
            `${exists ? 'Updated' : 'Imported'} HTTP-C2 profile "${cfg.Name}". Pick it in the Generate panel.`,
          );
          refreshServer();
          return;
        }
        if (pick.name === NEW) {
          const name = await vscode.window.showInputBox({ prompt: 'New profile name', validateInput: (v) => (v.trim() ? undefined : 'Name required') });
          if (!name) {
            return;
          }
          // Clone the built-in "default" profile as a starting template (IDs stripped so it saves as a new row).
          let template: any;
          try {
            template = stripIds(await c.getHttpC2ProfileByName('default'));
          } catch {
            template = { ServerConfig: { Headers: [], Cookies: [] }, ImplantConfig: { PathSegments: [], extensions: [] } };
          }
          template.Name = name;
          C2ProfilePanel.open(c, name, template, refreshServer);
          return;
        }
        // Existing profile — choose view (summary) or edit (full JSON).
        const action = await vscode.window.showQuickPick(
          [
            { label: '$(edit) Edit (full config)', id: 'edit' },
            { label: '$(eye) View summary', id: 'view' },
          ],
          { placeHolder: pick.name },
        );
        if (!action) {
          return;
        }
        const full = await c.getHttpC2ProfileByName(pick.name);
        if (action.id === 'view') {
          await showText(summarizeHttpC2Profile(full), 'markdown');
        } else {
          C2ProfilePanel.open(c, pick.name, full, refreshServer);
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`HTTP-C2 profiles failed: ${friendlyError(e)}`);
      }
    }),

    // --- Website content removal --------------------------------------
    reg('sliver.website.removeContent', async (node?: ServerItemNode) => {
      const c = active();
      if (!c || !node) {
        return;
      }
      try {
        const site = await c.getWebsite(node.value);
        const paths = Object.keys(site.Contents ?? {});
        if (!paths.length) {
          void vscode.window.showInformationMessage('Website has no content.');
          return;
        }
        const pick = await vscode.window.showQuickPick(paths, { placeHolder: 'Path to remove', canPickMany: true });
        if (!pick?.length) {
          return;
        }
        await c.websiteRemoveContent({ Name: node.value, Paths: pick });
        void vscode.window.showInformationMessage(`Removed ${pick.length} path(s) from "${node.value}"`);
        refreshServer();
      } catch (e) {
        void vscode.window.showErrorMessage(`remove content failed: ${friendlyError(e)}`);
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

    reg('sliver.profile.edit', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      try {
        const r = await client.implantProfiles();
        const prof = (r.Profiles ?? []).find((p: any) => p.Name === node.value);
        if (!prof?.Config) {
          void vscode.window.showErrorMessage(`Profile "${node.value}" has no config to edit.`);
          return;
        }
        GeneratePanel.openForProfile(client, prof.Name, prof.Config);
      } catch (e) {
        void vscode.window.showErrorMessage(`open profile failed: ${friendlyError(e)}`);
      }
    }),

    reg('sliver.profile.stage', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      try {
        // Encryption is optional; offer none / AES / RC4 to mirror the console's `profiles stage`.
        const enc = await vscode.window.showQuickPick(
          [
            { label: 'No encryption', id: 'none' },
            { label: 'AES (key + IV)', id: 'aes' },
            { label: 'RC4 (key)', id: 'rc4' },
          ],
          { placeHolder: 'Stager payload encryption' },
        );
        if (!enc) {
          return;
        }
        // NOTE: Sliver v1.7.3's GenerateStage handler has a bug — when Name is
        // non-empty it validates an uninitialized var and errors "name cannot be
        // blank". Leaving Name empty makes the server assign a random codename,
        // which is the only path that works. So we don't send a name here.
        const req: any = { Profile: node.value, Name: '' };
        if (enc.id === 'aes') {
          const key = await vscode.window.showInputBox({ prompt: 'AES key (16/24/32 bytes)' });
          if (key === undefined) {
            return;
          }
          const iv = await vscode.window.showInputBox({ prompt: 'AES IV (16 bytes)' });
          if (iv === undefined) {
            return;
          }
          req.AESEncryptKey = key;
          req.AESEncryptIv = iv;
        } else if (enc.id === 'rc4') {
          const key = await vscode.window.showInputBox({ prompt: 'RC4 key' });
          if (key === undefined) {
            return;
          }
          req.RC4EncryptKey = key;
        }
        const compress = await vscode.window.showQuickPick(['none', 'gzip', 'deflate9'], { placeHolder: 'Compression' });
        if (compress === undefined) {
          return;
        }
        req.Compress = compress === 'none' ? '' : compress;
        const prepend = await vscode.window.showQuickPick(['No', 'Yes'], { placeHolder: 'Prepend payload size (4-byte length header)?' });
        if (prepend === undefined) {
          return;
        }
        req.PrependSize = prepend === 'Yes';

        const g = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Building stager from "${node.value}"…` },
          () => client.generateStage(req),
        );
        if (!g.File) {
          void vscode.window.showWarningMessage('Stager: server returned no file.');
          return;
        }
        const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(g.File.Name || `${node.value}.bin`), saveLabel: 'Save Stager' });
        if (dest) {
          await vscode.workspace.fs.writeFile(dest, new Uint8Array(Buffer.from(g.File.Data)));
          void vscode.window.showInformationMessage(`Stager "${g.File.Name}" (${g.File.Data.length} bytes) → ${dest.fsPath}`);
        }
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        // Known upstream regression (BishopFox/sliver #2196): on server v1.7.3 the
        // stager code-generation template emits malformed Go, so the server fails
        // compiling its own main.go. Affects the official client too — not the UI.
        if (/expected 'IDENT'|main\.go/i.test(msg)) {
          void vscode.window.showErrorMessage(
            'Generate stager failed: the Sliver server (v1.7.3) could not compile the stager — a known server-side bug (BishopFox/sliver #2196) that also affects the official client. Upgrade the server to fix it. Regular implant generation is unaffected.',
          );
        } else {
          void vscode.window.showErrorMessage(`Generate stager failed: ${friendlyError(e)}`);
        }
      }
    }),

    reg('sliver.loot.rename', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      const name = await vscode.window.showInputBox({ prompt: 'New loot name', value: String(node.label ?? '') });
      if (!name) {
        return;
      }
      try {
        const all = await client.lootAll();
        const orig = (all.Loot ?? []).find((l: any) => l.ID === node.value);
        await client.lootUpdate({ ...(orig ?? {}), ID: node.value, Name: name });
        refreshServer();
      } catch (e) {
        void vscode.window.showErrorMessage(`rename loot failed: ${friendlyError(e)}`);
      }
    }),

    reg('sliver.cred.edit', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node?.data) {
        return;
      }
      const orig = node.data;
      const username = await vscode.window.showInputBox({ prompt: 'Username', value: orig.Username ?? '' });
      if (username === undefined) {
        return;
      }
      const plaintext = await vscode.window.showInputBox({ prompt: 'Plaintext password (blank = none)', value: orig.Plaintext ?? '' });
      if (plaintext === undefined) {
        return;
      }
      const hash = await vscode.window.showInputBox({ prompt: 'Hash (blank = none)', value: orig.Hash ?? '' });
      if (hash === undefined) {
        return;
      }
      try {
        await client.credsUpdate([{ ...orig, Username: username, Plaintext: plaintext, Hash: hash }]);
        refreshServer();
      } catch (e) {
        void vscode.window.showErrorMessage(`update credential failed: ${friendlyError(e)}`);
      }
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

    reg('sliver.host.removeIoc', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      try {
        const host = await client.host(node.value);
        const iocs: any[] = host.IOCs ?? [];
        if (!iocs.length) {
          void vscode.window.showInformationMessage('This host has no tracked IOCs.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          iocs.map((i) => ({ label: i.Path, description: i.FileHash ? `sha256 ${i.FileHash.slice(0, 12)}…` : '', ioc: i })),
          { placeHolder: 'IOC (dropped file) to remove from tracking', matchOnDescription: true },
        );
        if (!pick) {
          return;
        }
        // IOC is host-scoped; the server matches on the host UUID carried in the record.
        await client.hostIocRm({ ID: pick.ioc.ID, Path: pick.ioc.Path, FileHash: pick.ioc.FileHash });
        void vscode.window.showInformationMessage(`Removed IOC ${pick.ioc.Path}`);
        refreshServer();
      } catch (e) {
        void vscode.window.showErrorMessage(`Remove IOC failed: ${friendlyError(e)}`);
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

    reg('sliver.website.updateContent', async (node?: ServerItemNode) => {
      const client = active();
      if (!client || !node) {
        return;
      }
      try {
        const site = await client.getWebsite(node.value);
        const paths = Object.keys(site.Contents ?? {});
        if (!paths.length) {
          void vscode.window.showInformationMessage('Website has no content to update. Use “Add content”.');
          return;
        }
        const webPath = await vscode.window.showQuickPick(paths, { placeHolder: 'Which served path to replace?' });
        if (!webPath) {
          return;
        }
        const existing: any = site.Contents[webPath] ?? {};
        const file = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Replace with this file' });
        if (!file?.length) {
          return;
        }
        const filename = file[0].path.split('/').pop() ?? 'file';
        const contentType =
          (await vscode.window.showInputBox({ prompt: 'Content-Type', value: existing.ContentType || guessContentType(filename) })) ??
          'application/octet-stream';
        const data = Buffer.from(await vscode.workspace.fs.readFile(file[0]));
        await client.websiteUpdateContent({
          Name: node.value,
          Contents: {
            [webPath]: { Path: webPath, ContentType: contentType, Content: data, OriginalFile: filename, Size: String(data.length) },
          },
        });
        void vscode.window.showInformationMessage(`Updated ${webPath} on "${node.value}" (${data.length} bytes)`);
        refreshServer();
      } catch (e) {
        void vscode.window.showErrorMessage(`Update content failed: ${friendlyError(e)}`);
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
