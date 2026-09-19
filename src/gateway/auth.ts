import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { crossweaveDir } from '../core/paths.js';

export function tokenPath(projectRoot: string): string {
  return join(crossweaveDir(projectRoot), 'gateway.token');
}

export function readGatewayToken(projectRoot: string): string | undefined {
  const p = tokenPath(projectRoot);
  if (!existsSync(p)) return undefined;
  try { return readFileSync(p, 'utf8').trim() || undefined; } catch { return undefined; }
}

export function issueGatewayToken(projectRoot: string): string {
  const token = randomBytes(32).toString('hex'); // 64 hex chars
  const dir = crossweaveDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const p = tokenPath(projectRoot);
  writeFileSync(p, token + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
  return token;
}

export function revokeGatewayToken(projectRoot: string): boolean {
  const p = tokenPath(projectRoot);
  if (!existsSync(p)) return false;
  try { unlinkSync(p); return true; } catch { return false; }
}

export function verifyToken(projectRoot: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const expected = readGatewayToken(projectRoot);
  if (!expected) return false;
  // Constant-time compare on hex strings (same length)
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Read methods — safe to allow on a read-only token. */
export const READ_METHODS = new Set([
  'workspace.info', 'session.list', 'converge.status',
  'tui.event', 'tui.invalidate', 'session.data', 'session.exit',
  'workspace.ensure',
]);

/** Control methods require a control-capable token (today: same token, but split for future). */
export const CONTROL_METHODS = new Set([
  'workspace.gc', 'session.new', 'session.resume', 'session.stop', 'session.kill', 'session.rm',
  'session.rename', 'session.input', 'session.resize', 'session.attach',
  'land.session', 'contract.check',
]);

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method);
}
