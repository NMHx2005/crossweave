import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitFixture } from '../helpers/git-fixture.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
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
    try {
      const init = Bun.spawn([cwBin, 'init'], { cwd: fx.root, stdout: 'pipe', stderr: 'pipe' });
      expect(await init.exited).toBe(0);
      expect(existsSync(join(fx.root, '.crossweave', 'state.db'))).toBe(true);

      const list = Bun.spawn([cwBin, 'session', 'list'], { cwd: fx.root, stdout: 'pipe', stderr: 'pipe' });
      expect(await new Response(list.stdout).text()).toContain('no sessions');
      expect(await list.exited).toBe(0);

      // Awaited, not fire-and-forget: racing fx.cleanup() left a detached `cwd`
      // process alive on every run of this test.
      await Bun.spawn([cwBin, 'daemon', 'stop'], {
        cwd: fx.root, stdout: 'ignore', stderr: 'ignore',
      }).exited;

      // And ASSERTED, because the await alone guarded nothing: reverting it to
      // fire-and-forget still passed 3/3 while daemons accumulated 1, 2, 3.
      const survivors = Bun.spawnSync(['pgrep', '-f', cwdBin]);
      expect(survivors.stdout.toString().trim()).toBe('');
    } finally {
      await fx.cleanup();
    }
  }, 120_000);
});
