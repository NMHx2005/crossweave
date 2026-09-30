import { describe, expect, it } from 'bun:test';
import { CheckRunner, type CheckDeps } from '../../src/daemon/checks.js';

function setup(over: Partial<CheckDeps> = {}) {
  let now = 1_000_000;
  const calls: Array<{ command: string; cwd: string; env: Record<string, string> }> = [];
  let release: (r: { code: number; tail: string }) => void = () => undefined;
  const changes: string[] = [];
  const deps: CheckDeps = {
    run: (command, cwd, env) => { calls.push({ command, cwd, env }); return new Promise((res) => { release = res; }); },
    now: () => now,
    onChange: (id) => changes.push(id),
    ...over,
  };
  return { runner: new CheckRunner(deps), calls, changes, finish: (code: number, tail = '') => release({ code, tail }), tick: (ms: number) => { now += ms; } };
}
const codeOf = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('CheckRunner', () => {
  it('runs the command in the session\'s folder and reports running, then the verdict', async () => {
    const t = setup();
    t.runner.start('s1', 'bun test', '/wt/s1', { CW_SESSION_ID: 's1' }, { changed: 2, ahead: 1 });
    expect(t.calls).toEqual([{ command: 'bun test', cwd: '/wt/s1', env: { CW_SESSION_ID: 's1' } }]);
    expect(t.runner.get('s1', { changed: 2, ahead: 1 }, null)).toMatchObject({ state: 'running' });
    t.tick(4000);
    t.finish(0);
    await settle();
    expect(t.runner.get('s1', { changed: 2, ahead: 1 }, null)).toMatchObject({ state: 'pass', ms: 4000, stale: false });
    // Told when it started and when it finished.
    expect(t.changes).toEqual(['s1', 's1']);
  });

  it('a failing run is a fail with the end of its output, and the exit code', async () => {
    const t = setup();
    t.runner.start('s1', 'bun test', '/wt', {}, null);
    t.finish(1, '3 fail');
    await settle();
    expect(t.runner.get('s1', null, null)).toMatchObject({ state: 'fail', code: 1, tail: '3 fail' });
  });

  it('one run at a time per session, but two sessions run side by side', () => {
    const t = setup();
    t.runner.start('a', 'x', '/a', {}, null);
    expect(codeOf(() => t.runner.start('a', 'x', '/a', {}, null))).toBe('CHECK_RUNNING');
    expect(codeOf(() => t.runner.start('b', 'x', '/b', {}, null))).toBe('ok');
  });

  it('a run that could not start (the spawn threw) is a fail, never a stuck "running"', async () => {
    const t = setup({ run: () => Promise.reject(new Error('spawn failed')) });
    t.runner.start('s1', 'x', '/wt', {}, null);
    await settle();
    expect(t.runner.get('s1', null, null)).toMatchObject({ state: 'fail', code: -1 });
    // ...and the session can be checked again.
    expect(codeOf(() => t.runner.start('s1', 'x', '/wt', {}, null))).toBe('ok');
  });

  it('a verdict goes stale when the work moved on: more or fewer changed files, another commit, or later activity', async () => {
    const t = setup();
    t.runner.start('s1', 'x', '/wt', {}, { changed: 2, ahead: 1 });
    t.finish(0);
    await settle();
    expect(t.runner.get('s1', { changed: 2, ahead: 1 }, null)?.stale).toBe(false);
    expect(t.runner.get('s1', { changed: 3, ahead: 1 }, null)?.stale).toBe(true);
    expect(t.runner.get('s1', { changed: 2, ahead: 2 }, null)?.stale).toBe(true);
    // Terminal activity after the run finished (an agent editing) means the code may have changed.
    expect(t.runner.get('s1', { changed: 2, ahead: 1 }, 1_000_000 + 5000)?.stale).toBe(true);
    expect(t.runner.get('s1', { changed: 2, ahead: 1 }, 1_000_000 + 500)?.stale).toBe(false);
  });

  it('counts unknown when the run began: the first ones seen are the baseline, later changes make it stale', async () => {
    const t = setup();
    t.runner.start('s1', 'x', '/wt', {}, null);
    t.finish(0);
    await settle();
    expect(t.runner.get('s1', { changed: 2, ahead: 0 }, null)?.stale).toBe(false);
    expect(t.runner.get('s1', { changed: 2, ahead: 0 }, null)?.stale).toBe(false);
    expect(t.runner.get('s1', { changed: 3, ahead: 0 }, null)?.stale).toBe(true);
  });

  it('pins the verdict to the counts as the run ended, not as it began', async () => {
    const t = setup({ markAtFinish: async () => ({ changed: 5, ahead: 0 }) });
    t.runner.start('s1', 'x', '/wt', {}, { changed: 1, ahead: 0 });
    t.finish(0);
    await settle();
    expect(t.runner.get('s1', { changed: 5, ahead: 0 }, null)?.stale).toBe(false);
    expect(t.runner.get('s1', { changed: 6, ahead: 0 }, null)?.stale).toBe(true);
  });

  it('a failing counts read never loses the verdict', async () => {
    const t = setup({ markAtFinish: () => Promise.reject(new Error('git gone')) });
    t.runner.start('s1', 'x', '/wt', {}, null);
    t.finish(0);
    await settle();
    expect(t.runner.get('s1', null, null)?.state).toBe('pass');
  });

  it('nothing for a session never checked; forget drops it', async () => {
    const t = setup();
    expect(t.runner.get('nope', null, null)).toBeUndefined();
    t.runner.start('s1', 'x', '/wt', {}, null);
    t.finish(0);
    await settle();
    t.runner.forget('s1');
    expect(t.runner.get('s1', null, null)).toBeUndefined();
  });

  it('a result arriving for a session that was forgotten meanwhile is dropped', async () => {
    const t = setup();
    t.runner.start('s1', 'x', '/wt', {}, null);
    t.runner.forget('s1');
    t.finish(0);
    await settle();
    expect(t.runner.get('s1', null, null)).toBeUndefined();
  });
});

import { runShell } from '../../src/daemon/checks.js';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runShell', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cw-check-')));

  it('runs in the folder with the given environment and returns the exit code and the output', async () => {
    const r = await runShell('pwd; echo "$CW_X"; echo oops >&2; exit 3', dir, { CW_X: 'hello', PATH: process.env['PATH'] ?? '' });
    expect(r.code).toBe(3);
    expect(r.tail).toContain(dir);
    expect(r.tail).toContain('hello');
    expect(r.tail).toContain('oops');
  });

  it('keeps only the end of a long output', async () => {
    const r = await runShell('yes x | head -c 50000; echo THE-END', dir, { PATH: process.env['PATH'] ?? '' });
    expect(r.tail.length).toBeLessThanOrEqual(8000);
    expect(r.tail.trimEnd().endsWith('THE-END')).toBe(true);
  });

  it('stops a run that goes on too long, and says so with 124', async () => {
    const r = await runShell('sleep 30', dir, { PATH: process.env['PATH'] ?? '' }, 200);
    expect(r.code).toBe(124);
    expect(r.tail).toContain('timed out');
  });

  it('stops a run whose CHILD keeps the output open, and does not leave the child running', async () => {
    // `sh -c 'a; b'` forks `a` on every platform (a lone command is exec'd by some shells and forked by others):
    // killing only the shell left the child holding the pipe, and the run never came back until it ended by itself.
    const marker = join(dir, `child-${Date.now()}`);
    const started = Date.now();
    const r = await runShell(`sleep 20 & echo $! > ${marker}; wait`, dir, { PATH: process.env['PATH'] ?? '' }, 300);
    expect(r.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(4000);
    const pid = Number(readFileSync(marker, 'utf8').trim());
    await new Promise((res) => setTimeout(res, 300));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });

  it('has no stdin: a command that reads it ends instead of waiting for a person', async () => {
    const r = await runShell('cat; echo done', dir, { PATH: process.env['PATH'] ?? '' }, 5000);
    expect(r).toMatchObject({ code: 0 });
  });
});
