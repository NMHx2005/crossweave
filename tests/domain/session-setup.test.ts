import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideSetup,
  runTeardown,
  scanForSetupSentinel,
  SETUP_UNTRUSTED_NOTICE,
  withSetup,
  wrapWithSentinel,
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

describe('wrapWithSentinel', () => {
  // The stand-in "command" is itself `sh -c 'exit N'` (an external process), not a
  // bare `exit N` — a bare `exit` is a shell builtin that terminates execution right
  // there, before `ec=$?` or the printf after it ever run; only a REAL command (an
  // external program, or a builtin like `false` that returns instead of exiting)
  // behaves the way a real hooks.sessionSetup command does.
  test('runs the command, then emits an invisible OSC sentinel carrying its exit code', async () => {
    const { $ } = await import('bun');
    const wrapped = wrapWithSentinel("sh -c 'exit 0'");
    const out = await $`sh -c ${wrapped}`.quiet().text();
    expect(scanForSetupSentinel(out)).toEqual({ code: 0, rest: '' });
  });

  test('a failing command is still reported, with its own exit code', async () => {
    const { $ } = await import('bun');
    const wrapped = wrapWithSentinel("sh -c 'exit 7'");
    const out = await $`sh -c ${wrapped}`.quiet().nothrow().text();
    expect(scanForSetupSentinel(out)).toEqual({ code: 7, rest: '' });
  });

  test('preserves && chaining: the wrapped group\'s own exit status matches the command\'s', async () => {
    const { $ } = await import('bun');
    const ok = await $`sh -c ${withSetup(wrapWithSentinel("sh -c 'exit 0'"), 'echo ran')}`.quiet().text();
    expect(ok).toContain('ran');
    const failed = await $`sh -c ${withSetup(wrapWithSentinel("sh -c 'exit 1'"), 'echo ran')}`.quiet().nothrow().text();
    expect(failed).not.toContain('ran');
  });
});

describe('scanForSetupSentinel', () => {
  test('finds a complete sentinel in one buffer, and returns the rest with it consumed', () => {
    const buf = `some setup output\n\u001b]6961;0\u0007prompt$ `;
    expect(scanForSetupSentinel(buf)).toEqual({ code: 0, rest: 'some setup output\nprompt$ ' });
  });

  test('a nonzero code round-trips', () => {
    expect(scanForSetupSentinel('\u001b]6961;127\u0007')).toEqual({ code: 127, rest: '' });
  });

  test('an incomplete sentinel (split across chunks) is not matched yet', () => {
    expect(scanForSetupSentinel('output\u001b]6961;1')).toBeUndefined();
    expect(scanForSetupSentinel('')).toBeUndefined();
    expect(scanForSetupSentinel('plain output, no sentinel at all')).toBeUndefined();
  });

  test('two chunks concatenated by the caller complete the match', () => {
    const first = 'building...\u001b]6961;0';
    const second = `${first}\u0007done`;
    expect(scanForSetupSentinel(first)).toBeUndefined();
    expect(scanForSetupSentinel(second)).toEqual({ code: 0, rest: 'building...done' });
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
