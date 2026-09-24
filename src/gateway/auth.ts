import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { crossweaveDir } from '../core/paths.js';

export type TokenKind = 'read' | 'control';

export function tokenPath(projectRoot: string, kind: TokenKind = 'control'): string {
  return join(crossweaveDir(projectRoot), kind === 'read' ? 'gateway.read.token' : 'gateway.token');
}

export function legacyTokenPath(projectRoot: string): string {
  return join(crossweaveDir(projectRoot), 'gateway.token');
}

export function readGatewayToken(projectRoot: string, kind: TokenKind = 'control'): string | undefined {
  const p = tokenPath(projectRoot, kind);
  if (existsSync(p)) { try { return readFileSync(p, 'utf8').trim() || undefined; } catch { return undefined; } }
  // Backward compat: no read token file → fall back to legacy gateway.token for read
  if (kind === 'read') {
    const legacy = legacyTokenPath(projectRoot);
    if (existsSync(legacy)) try { return readFileSync(legacy, 'utf8').trim() || undefined; } catch { return undefined; }
  }
  return undefined;
}

export function issueGatewayToken(projectRoot: string, kind: TokenKind = 'control'): string {
  const token = randomBytes(32).toString('hex');
  const dir = crossweaveDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const p = tokenPath(projectRoot, kind);
  writeFileSync(p, token + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
  return token;
}

export function revokeGatewayToken(projectRoot: string, kind?: TokenKind): boolean {
  if (kind) {
    const p = tokenPath(projectRoot, kind);
    if (!existsSync(p)) return false;
    try { unlinkSync(p); return true; } catch { return false; }
  }
  // Revoke all
  let any = false;
  for (const k of ['read', 'control'] as TokenKind[]) {
    const pp = tokenPath(projectRoot, k);
    if (existsSync(pp)) { try { unlinkSync(pp); any = true; } catch {} }
  }
  // Legacy single file
  const leg = legacyTokenPath(projectRoot);
  if (existsSync(leg)) { try { unlinkSync(leg); any = true; } catch {} }
  return any;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function verifyToken(projectRoot: string, presented: string | undefined): TokenKind | undefined {
  if (!presented) return undefined;
  const control = readGatewayToken(projectRoot, 'control');
  if (control && constantTimeEqual(presented, control)) return 'control';
  const read = readGatewayToken(projectRoot, 'read');
  if (read && constantTimeEqual(presented, read)) return 'read';
  // Legacy single token (control)
  const legacy = existsSync(tokenPath(projectRoot, 'control')) ? undefined : (() => { try { return readFileSync(legacyTokenPath(projectRoot), 'utf8').trim() || undefined; } catch { return undefined; } })();
  if (legacy && constantTimeEqual(presented, legacy)) return 'control';
  return undefined;
}

export function verifyTokenBool(projectRoot: string, presented: string | undefined): boolean {
  return verifyToken(projectRoot, presented) !== undefined;
}

/** Read methods — safe to allow on a read-only token. */
export const READ_METHODS = new Set([
  'workspace.info', 'session.list', 'converge.status',
  'tui.event', 'tui.invalidate', 'session.data', 'session.exit',
  'workspace.ensure',
  // The journal is a read for a viewer and a control action for a window that is
  // reporting what it has open — a read token must not be able to rewrite the pane
  // set another client will restore from.
  'journal.get',
  'usage.summary', 'workspace.openFile', 'workspace.listFiles',
]);

/** Control methods require a control-capable token (today: same token, but split for future). */
export const CONTROL_METHODS = new Set([
  'workspace.gc', 'session.new', 'session.resume', 'session.stop', 'session.kill', 'session.rm',
  'session.rename', 'session.input', 'session.resize', 'session.attach',
  'land.session', 'contract.check', 'journal.set', 'session.wait', 'session.unwait',
]);

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method);
}

export function auditLogPath(projectRoot: string): string {
  return `${crossweaveDir(projectRoot)}/gateway.audit.log`;
}

export function appendAudit(projectRoot: string, entry: { method: string; kind?: string; at?: string }): void {
  try {
    const dir = crossweaveDir(projectRoot);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ at: entry.at ?? new Date().toISOString(), method: entry.method, kind: entry.kind ?? 'control' }) + '\n';
    appendFileSync(`${dir}/gateway.audit.log`, line);
  } catch {}
}
