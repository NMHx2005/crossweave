import { describe, it, expect } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMarkedPath, mergePaths, readLoginShellPath } from '../../src/core/login-path.js';

describe('extractMarkedPath', () => {
  // An interactive login shell runs the user's dotfiles, which may print banners.
  it('takes only the marked PATH, whatever the dotfiles printed around it', () => {
    expect(extractMarkedPath('Welcome!\n__CW_PATH__/a:/b__CW_PATH__\nbye')).toBe('/a:/b');
    expect(extractMarkedPath('no markers here')).toBeUndefined();
    expect(extractMarkedPath('__CW_PATH____CW_PATH__')).toBeUndefined();
  });
});

describe('mergePaths', () => {
  it('keeps the first PATH\'s order and appends what only the second has', () => {
    expect(mergePaths('/usr/bin:/bin', '/home/u/.local/bin:/usr/bin')).toBe('/usr/bin:/bin:/home/u/.local/bin');
    expect(mergePaths(undefined, '/x')).toBe('/x');
    expect(mergePaths('/x', undefined)).toBe('/x');
  });
});

describe('readLoginShellPath', () => {
  it('asks the user\'s shell for its PATH, and falls back when the shell fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-shell-'));
    try {
      const good = join(dir, 'good-sh');
      writeFileSync(good, '#!/bin/sh\necho "motd"\nprintf "__CW_PATH__%s__CW_PATH__" "/opt/agents/bin:/usr/bin"\n');
      chmodSync(good, 0o755);
      expect(await readLoginShellPath(good)).toBe('/opt/agents/bin:/usr/bin');
      const bad = join(dir, 'bad-sh');
      writeFileSync(bad, '#!/bin/sh\nexit 3\n');
      chmodSync(bad, 0o755);
      expect(await readLoginShellPath(bad)).toBeUndefined();
      expect(await readLoginShellPath(join(dir, 'missing'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
