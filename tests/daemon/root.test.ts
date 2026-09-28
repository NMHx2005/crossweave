import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDaemonRoot } from '../../src/daemon/root.js';

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'cw-root-'))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('resolveDaemonRoot', () => {
  it('serves a repository with git', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(resolveDaemonRoot(dir, {})).toEqual({ projectRoot: dir, git: true });
    expect(resolveDaemonRoot(dir, { CW_PLAIN: '1' })).toEqual({ projectRoot: dir, git: true });
  });

  it('serves a plain folder only when asked to', () => {
    expect(() => resolveDaemonRoot(dir, {})).toThrow(/Not inside a git repository/);
    expect(() => resolveDaemonRoot(dir, { CW_PLAIN: 'yes' })).toThrow();
    expect(resolveDaemonRoot(dir, { CW_PLAIN: '1' })).toEqual({ projectRoot: dir, git: false });
  });
});
