import { describe, expect, it, afterAll } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDebug, debugSession, type DebugBundle } from '../../src/cli/commands/debug.js';

/**
 * `cw debug`'s text layer: the bundle renders as labelled, paste-ready facts; every
 * section is optional (a session that never ran checks still renders); the secret
 * note appears unless `--raw`.
 */

const bundle = (over: Partial<DebugBundle> = {}): DebugBundle => ({
  session: { id: 's_1', name: 'dev', status: 'running', branch: 'cw/dev', worktreePath: '/w/dev' },
  agent: 'claude',
  activity: 'working',
  lastActivityAt: 1,
  errors: [],
  diff: { files: [], total: 0, uncommitted: 0 },
  ...over,
});

describe('renderDebug', () => {
  it('renders the minimal session as labelled lines', () => {
    const text = renderDebug(bundle());
    expect(text.split('\n')).toEqual([
      'session: dev (cw/dev, running)',
      'agent: claude — working',
      'check: never run',
      '(secrets scrubbed by a heuristic — check before pasting; --raw disables)',
    ]);
  });

  it('a failed check shows the exit code and the tail', () => {
    const text = renderDebug(bundle({ check: { state: 'fail', code: 1, ms: 2300, tail: 'FAIL src/a.test.ts', stale: true } }));
    expect(text).toContain('check: FAIL (exit 1 (2.3s), stale)');
    expect(text).toContain('FAIL src/a.test.ts');
  });

  it('error lines and the diffstat are labelled, the file list is cut server-side', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `src/f${i}.ts`, status: 'modified', added: 2, deleted: 1 }));
    const text = renderDebug(bundle({
      errors: [{ at: 5, line: 'error TS2345: got 1' }],
      diff: { files, total: 12, uncommitted: 3 },
    }));
    expect(text).toContain('errors seen in the terminal (heuristic):');
    expect(text).toContain('  error TS2345: got 1');
    expect(text).toContain('diff: 12 file(s), +24 −12 in the all shown, 3 uncommitted');
  });

  it('a capped diff says how much of the total is shown', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({ path: `src/f${i}.ts`, status: 'modified', added: 1, deleted: 0 }));
    const text = renderDebug(bundle({ diff: { files, total: 60, uncommitted: 0 } }));
    expect(text).toContain('diff: 60 file(s), +50 −0 in the 50 of 60 shown, 0 uncommitted');
    expect(text).toContain('  … 10 more');
  });

  it('latest words join the block; --raw drops the scrubber note', () => {
    const withWords = renderDebug(bundle({ latestWords: 'Plan: split the store\n' }));
    expect(withWords).toContain('latest words: Plan: split the store');
    expect(withWords).toContain('(secrets scrubbed');
    expect(renderDebug(bundle({ latestWords: 'done' }), true)).not.toContain('secrets scrubbed');
  });
});

describe('debugSession', () => {
  // sessionForCwd canonicalises with realpath: the worktree must exist on disk.
  const wt = join(tmpdir(), `cw-debug-${Date.now()}`);
  mkdirSync(wt, { recursive: true });
  const rows = [
    { id: 's_1', name: 'dev', worktreePath: wt },
    { id: 's_2', name: 'fix', worktreePath: null },
  ];

  it('an explicit name or id wins; not found is SESSION_NOT_FOUND', () => {
    expect(debugSession(rows, 'dev', wt)).toEqual({ ok: true, idOrName: 'dev' });
    expect(debugSession(rows, 's_1', wt)).toEqual({ ok: true, idOrName: 'dev' });
    expect(debugSession(rows, 'ghost', wt)).toMatchObject({ ok: false, code: 'SESSION_NOT_FOUND' });
  });

  it('without one, the session standing at the cwd; none → INVALID_ARGUMENTS', () => {
    expect(debugSession(rows, undefined, wt)).toEqual({ ok: true, idOrName: 'dev' });
    expect(debugSession(rows, undefined, '/elsewhere')).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
  });

  afterAll(() => { rmSync(wt, { recursive: true, force: true }); });
});
