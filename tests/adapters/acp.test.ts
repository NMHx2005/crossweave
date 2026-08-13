import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { AcpAdapter } from '../../src/adapters/acp.js';

const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-acp-agent.ts', import.meta.url));

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
    const adapter = new AcpAdapter({}, process.execPath, [FAKE_AGENT]);
    expect(adapter.kind).toBe('cursor');
    expect(adapter.enforcementTier).toBe('T1');
  });

  it('spawn -> write("__PING__") round-trips to "PONG" via onData', async () => {
    const adapter = new AcpAdapter({}, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('__PING__');
    await waitFor(() => read().includes('PONG'));
    proc.kill();
  });

  it('a tool_call/tool_call_update pair renders as a readable bracketed line via onData', async () => {
    const adapter = new AcpAdapter({}, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('__TOOL_CALL__');
    await waitFor(() => read().includes('DONE'));
    expect(read()).toContain('[cursor: edit test tool]');
    proc.kill();
  });

  it('resize is a no-op (no throw) — ACP has no terminal concept', async () => {
    const adapter = new AcpAdapter({}, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    expect(() => proc.resize(100, 40)).not.toThrow();
    proc.kill();
  });

  it('kill terminates the child process', async () => {
    const adapter = new AcpAdapter({}, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const exited = new Promise<number>((res) => proc.onExit(res));
    proc.kill();
    await expect(exited).resolves.toBeTypeOf('number');
  });

  it('a spawn failure (e.g. command not found) surfaces via onExit, not an uncaught crash', async () => {
    const adapter = new AcpAdapter({}, 'this-binary-does-not-exist-xyz', []);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const code = await new Promise<number>((res) => proc.onExit(res));
    expect(code).not.toBe(0);
  });
});
