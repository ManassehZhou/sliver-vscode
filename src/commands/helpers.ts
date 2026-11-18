import * as vscode from 'vscode';
import { ConnectionManager } from '../client/ConnectionManager';
import { SliverClient } from '../client/SliverClient';
import { Session, Beacon } from '../grpc/clientpb/client';

/** Returns the active connected client, or warns + returns undefined. */
export function requireActive(connections: ConnectionManager): SliverClient | undefined {
  const client = connections.active;
  if (!client || client.state !== 'connected') {
    void vscode.window.showWarningMessage('Sliver: not connected.');
    return undefined;
  }
  return client;
}

/** Open text in a new editor tab. */
export async function showText(content: string, language = 'log'): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** Pick a live session (used when a command is run from the palette). */
export async function pickSession(connections: ConnectionManager): Promise<Session | undefined> {
  const client = requireActive(connections);
  if (!client) {
    return undefined;
  }
  const { Sessions } = await client.getSessions();
  const live = Sessions.filter((s) => !s.IsDead);
  if (live.length === 0) {
    void vscode.window.showInformationMessage('No active sessions.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    live.map((s) => ({ label: s.Name, description: `${s.Username}@${s.Hostname}`, session: s })),
    { placeHolder: 'Select a session' },
  );
  return pick?.session;
}

/** Resolve a session from a tree node arg or fall back to a QuickPick. */
export async function resolveSession(
  connections: ConnectionManager,
  node?: { session?: Session },
): Promise<Session | undefined> {
  return node?.session ?? (await pickSession(connections));
}

/** Pick a process on a session via ps + QuickPick. Returns the chosen PID. */
export async function pickProcess(
  client: SliverClient,
  sessionId: string,
  placeHolder = 'Select a process',
): Promise<number | undefined> {
  const ps = await client.ps({ Request: { SessionID: sessionId } });
  const pick = await vscode.window.showQuickPick(
    ps.Processes.map((p) => ({
      label: `${p.Pid}  ${p.Executable}`,
      description: p.Owner,
      pid: p.Pid,
    })),
    { placeHolder, matchOnDescription: true },
  );
  return pick?.pid;
}

export type Node = { session?: Session; beacon?: Beacon };

/**
 * Translate raw RPC errors into operator-friendly messages. Sliver implants
 * reply "unknown message type" when they have no handler for a request —
 * typically a Windows-only operation run against a *nix implant, or a feature
 * (e.g. extensions) not compiled into this implant build.
 */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unknown message type/i.test(msg)) {
    return 'Not supported by this implant — likely a Windows-only operation, or a feature not built into this implant.';
  }
  return msg;
}

/**
 * Await an implant RPC and surface both gRPC errors and the implant-level
 * `Response.Err` field (Sliver returns implant errors there, not as gRPC
 * errors). Returns the response, or undefined if it errored (already shown).
 */
export async function runOp<T extends { Response?: { Err?: string } }>(
  label: string,
  op: Promise<T>,
): Promise<T | undefined> {
  try {
    const r = await op;
    if (r.Response?.Err) {
      void vscode.window.showErrorMessage(`${label}: ${r.Response.Err}`);
      return undefined;
    }
    return r;
  } catch (err) {
    void vscode.window.showErrorMessage(`${label}: ${friendlyError(err)}`);
    return undefined;
  }
}
