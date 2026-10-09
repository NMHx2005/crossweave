import { describe, expect, it } from 'bun:test';
import { assertNotBusy, checkpointKindFor, createAutoCheckpointer } from '../../src/daemon/checkpoint-trigger.js';
import type { CheckpointContext } from '../../src/domain/checkpoint.js';

describe('checkpointKindFor', () => {
  it('work starting takes a start checkpoint; a turn ending takes a turn one', () => {
    expect(checkpointKindFor('idle', 'working')).toBe('start');
    expect(checkpointKindFor('asked', 'working')).toBe('start');
    expect(checkpointKindFor('working', 'idle')).toBe('turn');
    expect(checkpointKindFor('working', 'asked')).toBe('turn');
  });
  it('a failure, or any other move, takes nothing', () => {
    expect(checkpointKindFor('working', 'failed')).toBeNull();
    expect(checkpointKindFor('idle', 'asked')).toBeNull();
    expect(checkpointKindFor('idle', 'idle')).toBeNull();
  });
});

const ctx: CheckpointContext = { projectRoot: '/p', sessionId: 's1', worktree: '/p/.wt' };

function harness(over: { context?: CheckpointContext | null; take?: () => Promise<unknown> } = {}) {
  const state: { agent: string | null; working: boolean } = { agent: 'claude', working: true };
  const taken: Array<[string, string]> = [];
  const logs: string[] = [];
  const auto = createAutoCheckpointer({
    agentOf: () => state.agent,
    isWorking: () => state.working,
    contextFor: () => (over.context === undefined ? ctx : over.context),
    take: over.take ?? (async (c, kind) => { taken.push([c.sessionId, kind]); }),
    log: (m) => { logs.push(m); },
  });
  return { auto, state, taken, logs };
}

describe('createAutoCheckpointer', () => {
  it('takes a turn checkpoint when an agent finishes, and a start one when it begins', async () => {
    const h = harness();
    await h.auto.onChange('s1', 'working', 'idle');
    await h.auto.onChange('s1', 'idle', 'working');
    expect(h.taken).toEqual([['s1', 'turn'], ['s1', 'start']]);
  });

  // A plain shell reaches `working` on any output (an `ls`, a dev server's logs): not a turn.
  it('takes nothing for a plain shell with no agent', async () => {
    const h = harness();
    h.state.agent = null;
    await h.auto.onChange('s1', 'working', 'idle');
    await h.auto.onChange('s1', 'idle', 'working');
    await h.auto.poll();
    expect(h.taken).toEqual([]);
  });

  // The output that makes a session "working" can arrive before `ps` sees the agent start: the start is owed, not lost.
  it('takes the start checkpoint as soon as the agent appears, if the session is still working', async () => {
    const h = harness();
    h.state.agent = null;
    await h.auto.onChange('s1', 'idle', 'working');
    await h.auto.poll();
    expect(h.taken).toEqual([]);
    h.state.agent = 'claude';
    await h.auto.poll();
    expect(h.taken).toEqual([['s1', 'start']]);
    await h.auto.poll();
    expect(h.taken).toHaveLength(1); // owed once, paid once
  });

  it('forgets an owed start when the session stops working without ever showing an agent', async () => {
    const h = harness();
    h.state.agent = null;
    await h.auto.onChange('s1', 'idle', 'working');
    h.state.working = false;
    await h.auto.poll();
    h.state.agent = 'claude';
    h.state.working = true;
    await h.auto.poll();
    expect(h.taken).toEqual([]);
  });

  it('takes nothing for a move that is neither a start nor an end', async () => {
    const h = harness();
    await h.auto.onChange('s1', 'working', 'failed');
    expect(h.taken).toEqual([]);
  });

  it('stays silent for a session with no worktree of its own or one that is gone', async () => {
    const h = harness({ context: null });
    await h.auto.onChange('s1', 'working', 'idle');
    expect(h.taken).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('logs and carries on when taking fails — the sweep must never see an error', async () => {
    const h = harness({ take: async () => { throw new Error('worktree vanished'); } });
    await expect(h.auto.onChange('s1', 'working', 'idle')).resolves.toBeUndefined();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain('worktree vanished');
  });
});

describe('assertNotBusy', () => {
  it('refuses a working session unless forced, and lets any other state through', () => {
    expect(() => assertNotBusy('dev', 'working', false)).toThrow(expect.objectContaining({ code: 'CHECKPOINT_SESSION_BUSY' }));
    expect(() => assertNotBusy('dev', 'working', true)).not.toThrow();
    expect(() => assertNotBusy('dev', 'idle', false)).not.toThrow();
    expect(() => assertNotBusy('dev', 'asked', false)).not.toThrow();
  });
});
