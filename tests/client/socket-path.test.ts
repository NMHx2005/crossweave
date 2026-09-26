import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectablePath, MAX_SOCKET_PATH_BYTES } from '../../src/client/socket-path.js';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'cw-sockpath-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const longSocket = (): string => join('/somewhere', 'x'.repeat(150), '.crossweave', 'daemon.sock');

describe('connectablePath', () => {
  it('keeps a path that fits in sun_path', () => {
    expect(connectablePath('/p/.crossweave/daemon.sock', base)).toBe('/p/.crossweave/daemon.sock');
  });

  // Node's connect() (the Electron cockpit) fails EINVAL past macOS's 104-byte
  // sun_path, where Bun's does not: the cockpit hung while the CLI worked.
  it('reaches a long path through a short symlink in a private dir', () => {
    const target = longSocket();
    const short = connectablePath(target, base);
    expect(Buffer.byteLength(short)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    expect(lstatSync(short).isSymbolicLink()).toBe(true);
    expect(readlinkSync(short)).toBe(target);
    const dir = join(short, '..');
    expect(lstatSync(dir).mode & 0o077).toBe(0);
  });

  it('is stable for one socket and distinct for two', () => {
    const a = connectablePath(longSocket(), base);
    expect(connectablePath(longSocket(), base)).toBe(a);
    expect(connectablePath(`${longSocket()}2`, base)).not.toBe(a);
  });

  it('repoints a stale link instead of trusting it', () => {
    const target = longSocket();
    const short = connectablePath(target, base);
    rmSync(short);
    symlinkSync('/elsewhere.sock', short);
    expect(readlinkSync(connectablePath(target, base))).toBe(target);
  });

  // Another user who can write the shared temp dir must not be able to pre-create
  // the link directory and aim our client at their own socket.
  it('refuses a link directory other users can write', () => {
    const target = longSocket();
    const dir = join(base, `cw-sock-${process.getuid?.() ?? 0}`);
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    expect(() => connectablePath(target, base)).toThrow(/SOCKET_DIR_UNSAFE|unsafe/i);
  });
});
