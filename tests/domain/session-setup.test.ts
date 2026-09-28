import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideSetup,
  runTeardown,
  SETUP_UNTRUSTED_NOTICE,
  withSetup,
} from '../../src/domain/session-setup.js';

const base = { hooks: { sessionSetup: 'bun install' }, trusted: true, alreadyRan: false, hasWorktree: true };

describe('decideSetup', () => {
  test('runs on a trusted, unrun, worktree session and asks to be recorded', () => {
    expect(decideSetup(base)).toEqual({ command: 'bun install', mark: true });
  });

  test('skips, with a reason, everything else — and never marks a skipped hook', () => {
    expect(decideSetup({ ...base, hooks: undefined })).toEqual({ mark: false, skipped: 'not-configured' });
    expect(decideSetup({ ...base, hooks: {} })).toEqual({ mark: false, skipped: 'not-configured' });
    expect(decideSetup({ ...base, hasWorktree: false })).toEqual({ mark: false, skipped: 'no-worktree' });
    expect(decideSetup({ ...base, alreadyRan: true })).toEqual({ mark: false, skipped: 'already-ran' });
    expect(decideSetup({ ...base, trusted: false })).toEqual({ mark: false, skipped: 'untrusted' });
  });

  test('already-ran is checked before trust, so a run is not re-reported as untrusted', () => {
    expect(decideSetup({ ...base, alreadyRan: true, trusted: false }).skipped).toBe('already-ran');
  });
});

describe('withSetup', () => {
  test('chains with && so a failed setup does not start the launcher', () => {
    expect(withSetup('bun install', 'claude')).toBe('bun install && claude');
    expect(withSetup('bun install', undefined)).toBe('bun install');
  });
});

describe('the untrusted notice', () => {
  test('is a shell comment, so typing it runs nothing', () => {
    expect(SETUP_UNTRUSTED_NOTICE.startsWith('#')).toBe(true);
  });
});

describe('runTeardown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-teardown-'));
  afterAll(() => {
    try { renameSync(dir, join(homedir(), '.Trash', `cw-teardown-${Date.now()}`)); } catch { /* left in tmp */ }
  });

  test('undefined on success, a warning (not a throw) on failure', async () => {
    expect(await runTeardown('exit 0', dir, {})).toBeUndefined();
    const warning = await runTeardown('echo boom 1>&2; exit 3', dir, {});
    expect(warning).toContain('sessionTeardown failed');
    expect(warning).toContain('boom');
  });

  test('a missing worktree is a no-op, not an error', async () => {
    expect(await runTeardown('exit 1', join(dir, 'does-not-exist'), {})).toBeUndefined();
  });
});
