import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ClaudePtyAdapter } from '../../src/adapters/claude-pty.js';
import { createAdapter } from '../../src/adapters/registry.js';

function collect(proc: { onData(cb: (c: string) => void): void }): () => string {
  let buf = '';
  proc.onData((c) => { buf += c; });
  return () => buf;
}

describe('ClaudePtyAdapter', () => {
  it('reports kind and enforcement tier T3', () => {
    const a = new ClaudePtyAdapter();
    expect(a.kind).toBe('claude');
    expect(a.enforcementTier).toBe('T3');
  });

  // Assert on the directory's unique basename, never on a substring of the temp path.
  // `tmpdir()` is `/private/var/folders/…/T` on macOS and contains no "tmp" at all.
  it('spawns a process in the requested cwd and streams its output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-adapter-'));
    try {
      const adapter = new ClaudePtyAdapter('sh', ['-c', 'pwd']);
      const proc = adapter.spawn({ cwd: dir, env: {}, cols: 80, rows: 24 });
      const read = collect(proc);
      const code = await new Promise<number>((res) => proc.onExit(res));
      expect(code).toBe(0);
      expect(read()).toContain(basename(dir));
      expect(proc.pid).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allocates a real tty so the child sees an interactive terminal', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'test -t 1 && echo TTY || echo NOTTY']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    await new Promise<number>((res) => proc.onExit(res));
    expect(read()).toContain('TTY');
  });

  it('forwards stdin to the child', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'read line; echo "got:$line"']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('hello\n');
    await new Promise<number>((res) => proc.onExit(res));
    expect(read()).toContain('got:hello');
  });

  it('injects the provided env', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'echo "v=$CW_TEST"']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: { CW_TEST: 'ok' }, cols: 80, rows: 24 });
    const read = collect(proc);
    await new Promise<number>((res) => proc.onExit(res));
    expect(read()).toContain('v=ok');
  });

  it('kills a long-running child', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'sleep 60']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    const exited = new Promise<number>((res) => proc.onExit(res));
    proc.kill('SIGKILL');
    await expect(exited).resolves.toBeTypeOf('number');
  });
});

describe('createAdapter', () => {
  it('returns the claude adapter', () => {
    expect(createAdapter('claude').kind).toBe('claude');
    expect(createAdapter('claude').enforcementTier).toBe('T3');
  });

  it('throws UNKNOWN_AGENT for an unsupported kind', () => {
    expect(() => createAdapter('cursor')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_AGENT' }) as unknown as Error,
    );
  });
});
