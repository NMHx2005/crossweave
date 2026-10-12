import { describe, it, expect, beforeEach, afterEach, test } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { commitFile, makeGitFixture, sweepStaleTemplates } from './git-fixture.js';

let scratch: string;

beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), 'cw-sweep-test-')); });
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

describe('sweepStaleTemplates', () => {
  it('removes a template owned by a dead pid, keeps one owned by this process', async () => {
    // Spawned, awaited, and thus reaped before we read its pid back — the OS will not
    // report this pid as alive again on any platform this suite runs on.
    const dead = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    const deadPid = dead.pid;
    await dead.exited;

    const stale = join(scratch, `cw-template-${deadPid}-x`);
    const live = join(scratch, `cw-template-${process.pid}-y`);
    await mkdir(stale);
    await mkdir(live);

    sweepStaleTemplates(scratch);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('leaves a directory that does not match the expected name shape alone', async () => {
    const other = join(scratch, 'cw-template-not-a-pid');
    await mkdir(other);

    sweepStaleTemplates(scratch);

    expect(existsSync(other)).toBe(true);
  });
});

test('git fixtures have independent working trees and histories', async () => {
  const first = await makeGitFixture();
  let second: Awaited<ReturnType<typeof makeGitFixture>> | undefined;

  try {
    second = await makeGitFixture();
    const secondHead = await $`git rev-parse HEAD`.cwd(second.root).quiet().text();
    await commitFile(first.root, 'first-only.txt', 'first\n', 'first fixture change');

    expect(await readFile(`${first.root}/first-only.txt`, 'utf8')).toBe('first\n');
    expect(existsSync(`${second.root}/first-only.txt`)).toBe(false);
    expect(await $`git rev-parse HEAD`.cwd(second.root).quiet().text()).toBe(secondHead);
  } finally {
    await first.cleanup();
    if (second) await second.cleanup();
  }
});
