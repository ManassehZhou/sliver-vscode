import * as vscode from 'vscode';

/** Shared output channel for diagnostics. Created lazily on first use. */
let channel: vscode.OutputChannel | undefined;

function out(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Sliver');
  }
  return channel;
}

function stamp(level: string, msg: string): string {
  return `[${level}] ${msg}`;
}

export const log = {
  info(msg: string): void {
    out().appendLine(stamp('info', msg));
  },
  warn(msg: string): void {
    out().appendLine(stamp('warn', msg));
  },
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? `: ${err.message}` : err ? `: ${String(err)}` : '';
    out().appendLine(stamp('error', msg + detail));
  },
  show(): void {
    out().show();
  },
  dispose(): void {
    channel?.dispose();
    channel = undefined;
  },
};
