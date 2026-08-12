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

interface RadarHookSettings {
  hooks: { PreToolUse: [{ matcher: string; hooks: [{ type: string; command: string; timeout: number }] }] };
}

/**
 * Spawns a `sh` child that echoes back its own argv (one `ARG:<value>` line
 * per arg), reads the `--settings` JSON `spawn()` actually passed it, and
 * returns the parsed settings. The pty translates LF to CRLF (see the
 * `TTY`/`test -t 1` test above), so every line carries a trailing \r that a
 * plain split('\n') would leave in place — stripped here, the same tolerance
 * every other assertion in this file gets for free from `toContain` on the
 * whole buffer.
 */
async function spawnAndReadRadarHookSettings(): Promise<RadarHookSettings> {
  const adapter = new ClaudePtyAdapter('sh', ['-c', 'for a in "$@"; do echo "ARG:$a"; done', '_']);
  const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
  const read = collect(proc);
  await new Promise<number>((res) => proc.onExit(res));

  const lines = read().replace(/\r/g, '').split('\n');
  expect(lines).toContain('ARG:--settings');
  const settingsLine = lines.find((l) => l.startsWith('ARG:') && l.includes('"hooks"'));
  expect(settingsLine).toBeDefined();
  return JSON.parse(settingsLine!.slice('ARG:'.length)) as RadarHookSettings;
}

describe('ClaudePtyAdapter', () => {
  it('reports kind and enforcement tier T2', () => {
    const a = new ClaudePtyAdapter();
    expect(a.kind).toBe('claude');
    expect(a.enforcementTier).toBe('T2');
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

  // Task 13 fans this stream out to every client attached to a session. One broken
  // viewer must not be able to starve the others, and a bare for-loop over the
  // listeners does exactly that — permanently, since the same subscriber throws on
  // every later chunk too.
  it('keeps delivering data to the other listeners when one throws', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'echo one; echo two']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    const seen: string[] = [];
    proc.onData(() => { seen.push('first'); });
    proc.onData(() => { throw new Error('bad subscriber'); });
    proc.onData(() => { seen.push('third'); });
    await new Promise<number>((res) => proc.onExit(res));
    expect(seen).toContain('first');
    expect(seen).toContain('third');
  });

  it('keeps calling the other exit listeners when one throws', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'exit 0']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    const seen: string[] = [];
    proc.onExit(() => { seen.push('first'); });
    proc.onExit(() => { throw new Error('bad subscriber'); });
    await new Promise<void>((res) => proc.onExit(() => { seen.push('third'); res(); }));
    expect(seen).toEqual(['first', 'third']);
  });

  // Pins a contract Task 13 depends on: the adapter buffers NOTHING, so anything
  // emitted before a subscriber attaches is gone. Scrollback is the session
  // runtime's job, not the adapter's. Synchronises on the data itself rather than a
  // timer so the test stays deterministic.
  it('does not buffer output for a listener that attaches later', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'echo early; read x; echo late']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    await new Promise<void>((res) => {
      proc.onData((c) => { if (c.includes('early')) res(); });
    });
    const late: string[] = [];
    proc.onData((c) => { late.push(c); });
    proc.write('go\n');
    await new Promise<number>((res) => proc.onExit(res));
    expect(late.join('')).not.toContain('early');
    expect(late.join('')).toContain('late');
  });

  it('spawn injects a scoped PreToolUse hook via --settings, calling cw radar-hook', async () => {
    const settings = await spawnAndReadRadarHookSettings();
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Edit|Write');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('radar-hook');
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
  });

  // Task 10's review caught that the dev-mode command was a bare path to the
  // `.ts` SOURCE file, which is checked into git without an executable bit —
  // `sh` (and Claude Code's own hook runner) cannot exec it directly, only
  // ever failing at the moment a real PreToolUse fires, in exactly the
  // `bun run src/cli/index.ts` dev workflow this project actually uses day to
  // day. Asserting on the JSON string alone (as the test above does) cannot
  // catch that class of bug — it has to actually be run.
  it('the injected --settings command is actually executable, not a bare unexecutable .ts path', async () => {
    const settings = await spawnAndReadRadarHookSettings();
    const command = settings.hooks.PreToolUse[0].hooks[0].command;

    // An empty stdin makes `runRadarHook`'s JSON.parse throw immediately, which
    // it catches and turns into `allow()` — no daemon connection, no session
    // lookup, just proof the command itself is exec-able at all. A command
    // built from the raw, non-executable source path (no interpreter prefix)
    // fails BEFORE any of that, with `Bun.spawn` throwing EACCES synchronously.
    const hookProc = Bun.spawn(command.split(' '), {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await hookProc.exited;
    const stdout = await new Response(hookProc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout).toContain('"permissionDecision":"allow"');
  });
});

describe('createAdapter', () => {
  it('returns the claude adapter', () => {
    expect(createAdapter('claude').kind).toBe('claude');
    expect(createAdapter('claude').enforcementTier).toBe('T2');
  });

  it('throws UNKNOWN_AGENT for an unsupported kind', () => {
    expect(() => createAdapter('cursor')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_AGENT' }) as unknown as Error,
    );
  });
});
