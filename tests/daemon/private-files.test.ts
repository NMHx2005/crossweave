import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardenStateFiles } from '../../src/daemon/private-files.js';

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('hardenStateFiles', () => {
  // SQLite creates the database under the umask (0644); only the socket was ever chmod'd. Once a
  // snapshot of terminal output lives in it, the file must not be readable by other users.
  test('makes the database and its companions readable by the user only, and the directory 0700', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cw-priv-')), '.crossweave');
    Bun.spawnSync(['mkdir', '-p', dir]);
    chmodSync(dir, 0o755);
    for (const f of ['state.db', 'state.db-wal', 'state.db-shm', 'journal.json']) {
      writeFileSync(join(dir, f), 'x');
      chmodSync(join(dir, f), 0o644);
    }
    hardenStateFiles(dir);
    expect(mode(dir)).toBe(0o700);
    for (const f of ['state.db', 'state.db-wal', 'state.db-shm', 'journal.json']) expect(mode(join(dir, f))).toBe(0o600);
  });

  test('a file that does not exist is skipped, not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-priv-'));
    expect(() => hardenStateFiles(dir)).not.toThrow();
  });

  test('a directory that does not exist is skipped, not an error', () => {
    expect(() => hardenStateFiles(join(tmpdir(), 'cw-nope-' + Date.now()))).not.toThrow();
  });
});
