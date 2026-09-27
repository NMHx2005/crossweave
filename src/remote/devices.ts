import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CrossweaveError } from '../core/errors.js';
import { globalCrossweaveDir } from '../core/paths.js';

/**
 * The phones paired with this Mac. A device is a name and the SHA-256 of a random
 * 256-bit token the phone keeps; the token itself is shown once, at pairing, and never
 * written here. A plain hash is enough (no slow KDF): the token has 256 bits of
 * entropy, so there is nothing to brute-force from a leaked file.
 */

export type Device = { id: string; name: string; createdAt: string; lastSeenAt: string | null };
type Stored = Device & { tokenHash: string };

const MAX_DEVICES = 20;
const MAX_NAME = 40;
/** A phone's last-seen time is kept to the minute: one write per connection, not per frame. */
const TOUCH_EVERY_MS = 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function remoteDir(home?: string): string {
  return join(globalCrossweaveDir(home), 'remote');
}

export function devicesPath(home?: string): string {
  return join(remoteDir(home), 'devices.json');
}

function ensureDir(home?: string): void {
  const dir = remoteDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Every stored device, or none when the file is missing or unreadable: fail closed. */
function load(home?: string): Stored[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(devicesPath(home), 'utf8'));
  } catch {
    return [];
  }
  const list = (raw as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(list)) return [];
  return list.filter((d): d is Stored => typeof d === 'object' && d !== null
    && typeof d.id === 'string' && typeof d.name === 'string' && typeof d.createdAt === 'string'
    && (d.lastSeenAt === null || typeof d.lastSeenAt === 'string')
    && typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash));
}

function save(list: Stored[], home?: string): void {
  ensureDir(home);
  const path = devicesPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, devices: list }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const publicOf = ({ id, name, createdAt, lastSeenAt }: Stored): Device => ({ id, name, createdAt, lastSeenAt });

const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Shown in Settings and the audit log: printable, one line, bounded. */
function cleanName(name: string): string {
  // A name comes from the phone: escape sequences must not reach a terminal (`cw remote devices`).
  const printable = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (printable === '' ? 'Phone' : printable).slice(0, MAX_NAME);
}

export function listDevices(home?: string): Device[] {
  return load(home).map(publicOf);
}

export function addDevice(name: string, opts: { home?: string; now?: () => Date } = {}): { device: Device; token: string } {
  const list = load(opts.home);
  if (list.length >= MAX_DEVICES) {
    throw new CrossweaveError('TOO_MANY_DEVICES', `${MAX_DEVICES} phones are paired already — Remove a device in Settings first`);
  }
  const token = randomBytes(32).toString('base64url');
  const stored: Stored = {
    id: randomUUID(),
    name: cleanName(name),
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    lastSeenAt: null,
    tokenHash: hashOf(token),
  };
  save([...list, stored], opts.home);
  return { device: publicOf(stored), token };
}

/** The device a presented token belongs to. Every stored hash is compared, in constant time. */
export function verifyDevice(token: unknown, home?: string): Device | undefined {
  if (typeof token !== 'string' || !TOKEN.test(token)) return undefined;
  const presented = Buffer.from(hashOf(token), 'hex');
  let found: Stored | undefined;
  for (const d of load(home)) {
    if (timingSafeEqual(presented, Buffer.from(d.tokenHash, 'hex'))) found = d;
  }
  return found === undefined ? undefined : publicOf(found);
}

export function removeDevice(id: string, home?: string): boolean {
  const list = load(home);
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) return false;
  save(next, home);
  return true;
}

export function touchDevice(id: string, at: Date, home?: string): void {
  const list = load(home);
  const d = list.find((x) => x.id === id);
  if (d === undefined) return;
  if (d.lastSeenAt !== null && at.getTime() - Date.parse(d.lastSeenAt) < TOUCH_EVERY_MS) return;
  d.lastSeenAt = at.toISOString();
  save(list, home);
}

/** Changes whenever the file does; the server polls it to drop a removed phone at once. */
export function devicesStamp(home?: string): string {
  const path = devicesPath(home);
  if (!existsSync(path)) return 'none';
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return 'none';
  }
}
