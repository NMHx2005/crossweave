import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitFixture } from '../helpers/git-fixture.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Pids of compiled daemons whose working directory is `projectRoot`. */
function daemonsServing(projectRoot: string): number[] {
  const want = realpathSync(projectRoot);
  const pids = Bun.spawnSync(['pgrep', '-f', cwdBin]).stdout.toString().split('\n').filter(Boolean).map(Number);
  return pids.filter((pid) => {
    try {
      if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`) === want;
      const out = Bun.spawnSync(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']).stdout.toString();
      return out.split('\n').some((l) => l === `n${want}`);
    } catch {
      return false; // exited between pgrep and the check
    }
  });
}
const cwBin = join(root, 'dist', 'cw');
const cwdBin = join(root, 'dist', 'cwd');

beforeAll(async () => {
  const proc = Bun.spawn(['bun', 'run', 'scripts/build.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
}, 180_000);

describe('compiled binaries', () => {
  it('produces both executables', () => {
    expect(existsSync(cwBin)).toBe(true);
    expect(existsSync(cwdBin)).toBe(true);
  });

  it('reports its version without any runtime installed alongside it', async () => {
    const proc = Bun.spawn([cwBin, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('runs a real workspace lifecycle from the binary alone', async () => {
    const fx = await makeGitFixture();
    const stop = (): Promise<number> => Bun.spawn([cwBin, 'daemon', 'stop'], {
      cwd: fx.root, stdout: 'ignore', stderr: 'ignore',
    }).exited;
    try {
      const init = Bun.spawn([cwBin, 'init'], { cwd: fx.root, stdout: 'pipe', stderr: 'pipe' });
      expect(await init.exited).toBe(0);
      expect(existsSync(join(fx.root, '.crossweave', 'state.db'))).toBe(true);

      const list = Bun.spawn([cwBin, 'session', 'list'], { cwd: fx.root, stdout: 'pipe', stderr: 'pipe' });
      expect(await new Response(list.stdout).text()).toContain('no sessions');
      expect(await list.exited).toBe(0);

      // Awaited, not fire-and-forget: racing fx.cleanup() left a detached `cwd`
      // process alive on every run of this test.
      await stop();

      // And ASSERTED, because the await alone guarded nothing: reverting it to
      // fire-and-forget still passed 3/3 while daemons accumulated 1, 2, 3. Scoped to
      // daemons serving THIS fixture — a machine-wide pgrep failed whenever any other
      // `dist/cwd` was running, including a real one the developer was using.
      expect(daemonsServing(fx.root)).toEqual([]);
    } finally {
      // Also on failure: an assertion above throwing used to skip the stop entirely,
      // leaking a daemon per failed run.
      await stop().catch(() => undefined);
      await fx.cleanup();
    }
  }, 120_000);
});
