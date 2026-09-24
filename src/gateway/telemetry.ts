import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { crossweaveDir } from '../core/paths.js';

function perDayPath(projectRoot: string, day: string): string {
  return join(crossweaveDir(projectRoot), `telemetry-${day}.json`);
}
function consentPath(projectRoot: string): string {
  return join(crossweaveDir(projectRoot), 'telemetry-consent.json');
}

export function getConsent(projectRoot: string): boolean {
  try {
    const raw = readFileSync(consentPath(projectRoot), 'utf8');
    const v = JSON.parse(raw) as { consent?: boolean };
    return v.consent === true;
  } catch { return false; }
}
export function setConsent(projectRoot: string, consent: boolean): void {
  mkdirSync(crossweaveDir(projectRoot), { recursive: true });
  const p = consentPath(projectRoot);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ consent }, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, p);
}
export function record(projectRoot: string, event: Record<string, unknown>): void {
  if (!getConsent(projectRoot)) return;
  const day = new Date().toISOString().slice(0, 10);
  const p = perDayPath(projectRoot, day);
  mkdirSync(crossweaveDir(projectRoot), { recursive: true });
  let arr: Record<string, unknown>[] = [];
  try { arr = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>[]; if (!Array.isArray(arr)) arr = []; } catch {}
  // Never record code/paths/prompts — only allow listed keys
  const safe: Record<string, unknown> = {};
  for (const k of ['kind', 'agentKind', 'at']) if (k in event) safe[k] = event[k];
  arr.push({ ...safe, at: new Date().toISOString() });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, p);
}
export async function flush(projectRoot: string): Promise<void> {
  if (!getConsent(projectRoot)) return;
  // Best-effort POST per-day — no throw
  try {
    const day = new Date().toISOString().slice(0, 10);
    const p = perDayPath(projectRoot, day);
    if (!existsSync(p)) return;
    const body = readFileSync(p, 'utf8');
    // Use fetch if available (Bun), otherwise skip
    const f = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!f) return;
    await f('https://api.deck.spacevibe.dev/v1/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  } catch {}
}
