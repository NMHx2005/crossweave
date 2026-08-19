import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { AcpAdapter } from '../../src/adapters/acp.js';
import type { DecideBlockedParams, DecideBlockedResult } from '../../src/radar/decision.js';
import type { RecordUsageParams } from '../../src/domain/usage.js';
import type { NotifyEvent } from '../../src/notify/dispatcher.js';

const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-acp-agent.ts', import.meta.url));

// Task 4 widened AcpAdapterDeps to require resolveWorkspaceId/decideBlocked; these
// pre-existing tests exercise transport/lifecycle only and never call requestPermission,
// so a no-op stub satisfying the interface is all they need.
const NOOP_DEPS = { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked: () => ({ collisions: [], blocked: false }) };

function collect(proc: { onData(cb: (c: string) => void): void }): () => string {
  let buf = '';
  proc.onData((c) => { buf += c; });
  return () => buf;
}

/** Polls until `predicate()` is true or the timeout elapses — ACP round-trips are async
 * (spawn -> initialize -> session/new -> prompt -> update), unlike ClaudePtyAdapter's
 * synchronous pty write, so tests can't just await one call and read the result. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('AcpAdapter', () => {
  it('reports kind and enforcement tier T1', () => {
    const adapter = new AcpAdapter(NOOP_DEPS, process.execPath, [FAKE_AGENT]);
    expect(adapter.kind).toBe('cursor');
    expect(adapter.enforcementTier).toBe('T1');
  });

  it('default spawn args trust the workspace so cursor-agent never shows its interactive trust prompt', () => {
    expect(AcpAdapter.DEFAULT_ARGS).toEqual(['--trust', 'agent', 'acp']);
  });

  it('spawn -> write("__PING__") round-trips to "PONG" via onData', async () => {
    const adapter = new AcpAdapter(NOOP_DEPS, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('__PING__');
    await waitFor(() => read().includes('PONG'));
    proc.kill();
  });

  it('a tool_call/tool_call_update pair renders as a readable bracketed line via onData', async () => {
    const adapter = new AcpAdapter(NOOP_DEPS, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('__TOOL_CALL__');
    await waitFor(() => read().includes('DONE'));
    expect(read()).toContain('[cursor: edit test tool]');
    proc.kill();
  });

  it('a usage_update notification calls recordUsage with tokens and cost', async () => {
    const seen: RecordUsageParams[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: (params) => { seen.push(params); },
        notify: () => {},
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 16700, size: 200000, cost: { amount: 0.0123, currency: 'USD' } })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));
    expect(seen).toEqual([{ sessionId: 's_1', tokensUsed: 16700, costUsd: 0.0123 }]);
    proc.kill();
  });

  it('a usage_update with a non-USD currency: recordUsage gets tokens but costUsd is skipped, not mislabeled', async () => {
    const seen: RecordUsageParams[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: (params) => { seen.push(params); },
        notify: () => {},
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 16700, size: 200000, cost: { amount: 0.0123, currency: 'EUR' } })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));
    expect(seen).toEqual([{ sessionId: 's_1', tokensUsed: 16700, costUsd: undefined }]);
    proc.kill();
  });

  it('a usage_update with a lowercase "usd" currency is still trusted (case-insensitive)', async () => {
    const seen: RecordUsageParams[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: (params) => { seen.push(params); },
        notify: () => {},
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 16700, size: 200000, cost: { amount: 0.0123, currency: 'usd' } })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));
    expect(seen).toEqual([{ sessionId: 's_1', tokensUsed: 16700, costUsd: 0.0123 }]);
    proc.kill();
  });

  it('a usage_update with no cost field: recordUsage gets tokens only, costUsd undefined', async () => {
    const seen: RecordUsageParams[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: (params) => { seen.push(params); },
        notify: () => {},
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 500, size: 200000 })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));
    expect(seen).toEqual([{ sessionId: 's_1', tokensUsed: 500, costUsd: undefined }]);
    proc.kill();
  });

  it('a usage_update with no CW_SESSION_ID in env: recordUsage is never called (best-effort, no session to attribute it to)', async () => {
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: () => { throw new Error('must not be called with no session id'); },
        notify: () => {},
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 500, size: 200000 })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));
    proc.kill();
  });

  it('a usage_update where recordUsage throws does not crash the adapter or break subsequent onData', async () => {
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: () => { throw new Error('simulated DB error'); },
        notify: () => {},
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 500, size: 200000 })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));
    proc.kill();
  });

  it('a clean permission request (decideBlocked returns not blocked) resolves to allow', async () => {
    const decideBlocked = (): DecideBlockedResult => ({ collisions: [], blocked: false });
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:allow');
    proc.kill();
  });

  it('a blocked permission request (decideBlocked returns blocked) resolves to reject', async () => {
    const decideBlocked = (): DecideBlockedResult => ({ collisions: [], blocked: true });
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject');
    proc.kill();
  });

  it('multiple locations: ANY blocked location rejects the whole call', async () => {
    const seen: string[] = [];
    const decideBlocked = (params: DecideBlockedParams): DecideBlockedResult => {
      seen.push(params.path);
      return { collisions: [], blocked: params.path === 'b.ts' };
    };
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({
      locations: [{ path: `${process.cwd()}/a.ts` }, { path: `${process.cwd()}/b.ts` }], kind: 'edit',
    })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject');
    expect(seen).toEqual(['a.ts', 'b.ts']);
    proc.kill();
  });

  it('no locations on the tool call (e.g. an execute call the agent chose not to report): nothing to check, allowed', async () => {
    const decideBlocked = (): DecideBlockedResult => {
      throw new Error('must not be called when locations is empty');
    };
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ kind: 'execute' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:allow');
    proc.kill();
  });

  it('an unexpected internal error (decideBlocked throws) fails CLOSED, not open — T1 is the strong tier', async () => {
    const decideBlocked = (): DecideBlockedResult => {
      throw new Error('simulated internal error');
    };
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject');
    proc.kill();
  });

  it('CW_SESSION_ID missing from env: fails CLOSED (defensive — this is a wiring bug, not ordinary degradation)', async () => {
    const decideBlocked = (): DecideBlockedResult => {
      throw new Error('must not be called when there is no session id to resolve');
    };
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject');
    proc.kill();
  });

  it('a blocked decision with no reject_once option falls back within the reject CLASS (reject_always), never to allow', async () => {
    const decideBlocked = (): DecideBlockedResult => ({ collisions: [], blocked: true });
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({
      locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit',
      options: [
        { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
        { kind: 'reject_always', name: 'Always Reject', optionId: 'always-reject' },
      ],
    })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:always-reject');
    proc.kill();
  });

  it('a blocked decision with NO reject option at all cancels rather than falling back to allow', async () => {
    const decideBlocked = (): DecideBlockedResult => ({ collisions: [], blocked: true });
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({
      locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit',
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
    })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:cancelled');
    proc.kill();
  });

  it('a blocked permission decision fires a "blocked" notify event', async () => {
    const events: NotifyEvent[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: true }),
        recordUsage: () => {},
        notify: (event) => { events.push(event); },
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'blocked', session: 's_1' });
    proc.kill();
  });

  it('an allowed permission decision fires no notify event', async () => {
    const events: NotifyEvent[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: () => {},
        notify: (event) => { events.push(event); },
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(events).toHaveLength(0);
    proc.kill();
  });

  it('a fail-closed internal error (decideBlocked throws) does NOT fire a "blocked" notify event — it is not a real collision block', async () => {
    const events: NotifyEvent[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => { throw new Error('simulated internal error'); },
        recordUsage: () => {},
        notify: (event) => { events.push(event); },
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject'); // still fails closed
    expect(events).toHaveLength(0); // but does not claim a collision-block happened
    proc.kill();
  });

  it('a location outside the worktree is skipped (not checked, not denied) if it is the only location', async () => {
    const decideBlocked = (): DecideBlockedResult => {
      throw new Error('must not be called for a location outside the worktree');
    };
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: '/etc/passwd' }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:allow');
    proc.kill();
  });

  it('a read-only tool call (kind: read) is allowed even with a location that would otherwise block — the policy is about write-write collisions', async () => {
    const decideBlocked = (): DecideBlockedResult => {
      throw new Error('must not be called for a read-only tool call');
    };
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, notify: () => {}, decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'read' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:allow');
    proc.kill();
  });

  it('stderr output from the child is surfaced via onData (an unauthenticated/failing agent is not silently wedged)', async () => {
    const adapter = new AcpAdapter(NOOP_DEPS, 'sh', ['-c', 'echo AUTH_ERROR >&2; sleep 5']);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    await waitFor(() => read().includes('AUTH_ERROR'));
    proc.kill();
  });

  it('resize is a no-op (no throw) — ACP has no terminal concept', async () => {
    const adapter = new AcpAdapter(NOOP_DEPS, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    expect(() => proc.resize(100, 40)).not.toThrow();
    proc.kill();
  });

  it('kill terminates the child process', async () => {
    const adapter = new AcpAdapter(NOOP_DEPS, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const exited = new Promise<number>((res) => proc.onExit(res));
    proc.kill();
    await expect(exited).resolves.toBeTypeOf('number');
  });

  it('a spawn failure (e.g. command not found) surfaces via onExit, not an uncaught crash', async () => {
    const adapter = new AcpAdapter(NOOP_DEPS, 'this-binary-does-not-exist-xyz', []);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const code = await new Promise<number>((res) => proc.onExit(res));
    expect(code).not.toBe(0);
  });
});
