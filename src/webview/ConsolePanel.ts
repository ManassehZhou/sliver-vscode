import * as vscode from 'vscode';
import { SliverClient } from '../client/SliverClient';
import { getNonce, cspMeta } from './webviewUtil';

/**
 * A per-session command console: a scrollback view plus an input box. Each
 * submitted line is run via the Execute RPC (parsed into path + args) and the
 * stdout/stderr is appended. One panel per session id (reused on re-open).
 */
export class ConsolePanel {
  private static panels = new Map<string, ConsolePanel>();

  static open(client: SliverClient, sessionId: string, label: string): void {
    const existing = ConsolePanel.panels.get(sessionId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    ConsolePanel.panels.set(sessionId, new ConsolePanel(client, sessionId, label));
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly client: SliverClient,
    private readonly sessionId: string,
    label: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'sliver.console',
      `Console: ${label}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => ConsolePanel.panels.delete(sessionId));
  }

  private async onMessage(msg: { type: string; line?: string }): Promise<void> {
    if (msg.type !== 'run' || !msg.line) {
      return;
    }
    const argv = msg.line.trim().split(/\s+/);
    const path = argv[0];
    const args = argv.slice(1);
    this.post({ type: 'echo', text: `$ ${msg.line}` });
    try {
      const res = await this.client.execute({
        Path: path,
        Args: args,
        Output: true,
        Request: { SessionID: this.sessionId, Timeout: '60' },
      });
      const stdout = Buffer.from(res.Stdout).toString('utf8');
      const stderr = Buffer.from(res.Stderr).toString('utf8');
      if (stdout) {
        this.post({ type: 'out', text: stdout });
      }
      if (stderr) {
        this.post({ type: 'err', text: stderr });
      }
      if (!stdout && !stderr) {
        this.post({ type: 'out', text: `(exit ${res.Status}, no output)` });
      }
    } catch (err) {
      this.post({ type: 'err', text: (err as Error).message });
    }
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
  body { margin: 0; padding: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 8px; white-space: pre-wrap; word-break: break-word; }
  .echo { color: var(--vscode-terminal-ansiBrightBlue); }
  .err { color: var(--vscode-terminal-ansiRed); }
  #inputbar { display: flex; border-top: 1px solid var(--vscode-panel-border); }
  #prompt { padding: 6px 8px; color: var(--vscode-terminal-ansiBrightGreen); }
  #cmd { flex: 1; background: transparent; border: none; outline: none; color: var(--vscode-input-foreground); font-family: inherit; font-size: inherit; padding: 6px 8px 6px 0; }
</style>
</head>
<body>
  <div id="log"></div>
  <div id="inputbar"><span id="prompt">&gt;</span><input id="cmd" autofocus placeholder="command (e.g. whoami)" /></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const cmd = document.getElementById('cmd');
  const history = []; let hi = 0;
  function append(text, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'echo') append(m.text, 'echo');
    else if (m.type === 'err') append(m.text, 'err');
    else if (m.type === 'out') append(m.text);
  });
  cmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && cmd.value.trim()) {
      history.push(cmd.value); hi = history.length;
      vscode.postMessage({ type: 'run', line: cmd.value });
      cmd.value = '';
    } else if (e.key === 'ArrowUp' && hi > 0) {
      hi--; cmd.value = history[hi]; e.preventDefault();
    } else if (e.key === 'ArrowDown' && hi < history.length - 1) {
      hi++; cmd.value = history[hi]; e.preventDefault();
    }
  });
</script>
</body>
</html>`;
  }
}
