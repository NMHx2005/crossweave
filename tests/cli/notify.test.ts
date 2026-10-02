import { describe, expect, it } from 'bun:test';
import { symlinkSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNotifyRequest } from '../../src/cli/commands/notify.js';
import { sessionForCwd } from '../../src/cli/context.js';

const codeOf = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };

describe('buildNotifyRequest', () => {
  it('uses this shell\'s own session and joins the words into the message', () => {
    expect(buildNotifyRequest(['tests', 'written'], {}, { CW_SESSION_ID: 's_1' })).toEqual({ idOrName: 's_1', kind: 'done', message: 'tests written' });
  });

  it('--session and --kind override', () => {
    expect(buildNotifyRequest(['q?'], { session: 'alpha', kind: 'ask' }, { CW_SESSION_ID: 's_1' })).toEqual({ idOrName: 'alpha', kind: 'ask', message: 'q?' });
  });

  it('no message is fine: done with nothing to add', () => {
    expect(buildNotifyRequest([], {}, { CW_SESSION_ID: 's_1' }).message).toBe('');
  });

  it('refuses a kind outside the two, and a call that names no session', () => {
    expect(codeOf(() => buildNotifyRequest([], { kind: 'run' }, { CW_SESSION_ID: 's_1' }))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => buildNotifyRequest([], {}, {}))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => buildNotifyRequest([], {}, { CW_SESSION_ID: '' }))).toBe('INVALID_ARGUMENTS');
  });
});

describe('sessionForCwd (the hook-shell fallback)', () => {
  // macOS: /var is a symlink to /private/var — a stored worktree path and the shell's
  // cwd often disagree in spelling; only canonical forms should be compared.
  it('matches a cwd that is spelled differently but is the same directory', () => {
    const base = join(tmpdir(), `cw-notify-cwd-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const link = `${base}/link`;
    const wt = `${base}/wt`;
    mkdirSync(wt, { recursive: true });
    symlinkSync(wt, link);
    try {
      const rows = [
        { name: 'other', worktreePath: '/definitely/not/this' },
        { name: 'dev', worktreePath: `${base}/wt/` },
      ];
      expect(sessionForCwd(rows, link)).toBe('dev');
      expect(sessionForCwd(rows, wt)).toBe('dev');
      expect(sessionForCwd(rows, `${base}/wt//`)).toBe('dev');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('finds nothing when the cwd is not any session worktree, or the worktree is gone', () => {
    const rows = [
      { name: 'gone', worktreePath: '/no/such/dir/anywhere' },
      { name: 'plain', worktreePath: null },
    ];
    expect(sessionForCwd(rows, process.cwd())).toBeUndefined();
  });

  it('resolves the real path of its own claim (the fixture uses a true tmpdir)', () => {
    expect(realpathSync(tmpdir()).length).toBeGreaterThan(0);
  });
});
