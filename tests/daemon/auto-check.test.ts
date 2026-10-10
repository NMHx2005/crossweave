import { describe, expect, it } from 'bun:test';
import { createAutoChecker } from '../../src/daemon/auto-check.js';
import { CrossweaveError } from '../../src/core/errors.js';

function harness(over: { enabled?: () => boolean; fail?: (id: string) => unknown } = {}) {
  const state = { on: true };
  const ran: string[] = [];
  const logs: string[] = [];
  const checker = createAutoChecker({
    enabled: over.enabled ?? (() => state.on),
    run: (id) => {
      const err = over.fail?.(id);
      if (err !== undefined) throw err;
      ran.push(id);
    },
    log: (m) => { logs.push(m); },
  });
  return { checker, state, ran, logs };
}

const code = (c: string): CrossweaveError => new CrossweaveError(c, c);

describe('createAutoChecker', () => {
  it('runs once for a turn that changed, or may have changed, the tree', () => {
    const h = harness();
    h.checker.turnEnded('a', 'changed', 'idle');
    expect(h.ran).toEqual(['a']);
    h.checker.checkFinished('a');
    h.checker.turnEnded('a', 'unknown', 'idle');
    expect(h.ran).toEqual(['a', 'a']);
  });

  it('a turn that changed nothing starts nothing', () => {
    const h = harness();
    h.checker.turnEnded('a', 'unchanged', 'idle');
    expect(h.ran).toEqual([]);
  });

  it('is off when the setting is off, or when reading it fails, and then leaves nothing owed', () => {
    const h = harness();
    h.state.on = false;
    h.checker.turnEnded('a', 'changed', 'idle');
    expect(h.ran).toEqual([]);
    h.state.on = true;
    h.checker.turnEnded('b', 'unchanged', 'idle');
    expect(h.ran).toEqual([]); // `a` was not kept owed while the setting was off
    const broken = harness({ enabled: () => { throw new Error('unreadable'); } });
    broken.checker.turnEnded('a', 'changed', 'idle');
    expect(broken.ran).toEqual([]);
  });

  // `working -> asked` is also what a permission prompt looks like: tests on half-finished edits at every approval would
  // be wasteful and, with one run at a time, would swallow the real final run.
  it('an ask marks the session owed but starts nothing; the next idle end pays it even if that turn changed nothing', () => {
    const h = harness();
    h.checker.turnEnded('a', 'changed', 'asked');
    expect(h.ran).toEqual([]);
    h.checker.turnEnded('a', 'unchanged', 'idle');
    expect(h.ran).toEqual(['a']);
  });

  it('a run that cannot start because one is already going is started when a check finishes', () => {
    let busy = true;
    const ran: string[] = [];
    const checker = createAutoChecker({ enabled: () => true, log: () => undefined,
      run: (id) => { if (busy) throw code('CHECK_RUNNING'); ran.push(id); } });
    checker.turnEnded('a', 'changed', 'idle');
    expect(ran).toEqual([]);
    busy = false;
    checker.checkFinished('a');
    expect(ran).toEqual(['a']);
    checker.checkFinished('a');
    expect(ran).toEqual(['a']); // started once, no longer owed
  });

  it('one automatic run at a time: another session waits for the first to finish', () => {
    const h = harness();
    h.checker.turnEnded('a', 'changed', 'idle');
    h.checker.turnEnded('b', 'changed', 'idle');
    expect(h.ran).toEqual(['a']);
    h.checker.checkFinished('a');
    expect(h.ran).toEqual(['a', 'b']);
  });

  it("a manual run in session A does not hold up session B", () => {
    const h = harness({ fail: (id) => (id === 'a' ? code('CHECK_RUNNING') : undefined) });
    h.checker.turnEnded('a', 'changed', 'idle');
    h.checker.turnEnded('b', 'changed', 'idle');
    expect(h.ran).toEqual(['b']);
  });

  it('the quiet failures drop the mark silently, and a later changing turn can owe it again', () => {
    for (const c of ['CHECK_NOT_CONFIGURED', 'CHECK_UNTRUSTED', 'SESSION_NO_WORKDIR', 'SESSION_NOT_RUNNING']) {
      let fail = true;
      const ran: string[] = [];
      const logs: string[] = [];
      const checker = createAutoChecker({ enabled: () => true, log: (m) => { logs.push(m); },
        run: (id) => { if (fail) throw code(c); ran.push(id); } });
      checker.turnEnded('a', 'changed', 'idle');
      checker.checkFinished('a');
      expect(ran).toEqual([]);
      expect(logs).toEqual([]);
      fail = false;
      checker.turnEnded('a', 'unchanged', 'idle');
      expect(ran).toEqual([]); // no longer owed
      checker.turnEnded('a', 'changed', 'idle');
      expect(ran).toEqual(['a']);
    }
  });

  it('any other failure is logged once, drops the mark, and never throws', () => {
    const h = harness({ fail: () => new Error('disk on fire') });
    expect(() => h.checker.turnEnded('a', 'changed', 'idle')).not.toThrow();
    expect(h.logs.length).toBe(1);
    h.checker.checkFinished('a');
    expect(h.logs.length).toBe(1);
  });

  // A lost "finished" signal must not switch the feature off for good.
  it('a run that never reported back stops holding the slot after a while', () => {
    let at = 0;
    const ran: string[] = [];
    const checker = createAutoChecker({ enabled: () => true, log: () => undefined, now: () => at, run: (id) => { ran.push(id); } });
    checker.turnEnded('a', 'changed', 'idle');
    at = 14 * 60_000;
    checker.turnEnded('b', 'changed', 'idle');
    expect(ran).toEqual(['a']);
    at = 16 * 60_000;
    checker.turnEnded('c', 'changed', 'idle');
    expect(ran).toEqual(['a', 'b']);
  });
});
