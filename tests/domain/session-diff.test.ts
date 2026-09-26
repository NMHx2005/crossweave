import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { sessionDiff } from '../../src/domain/session-diff.js';
import { commitFile, makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
beforeEach(async () => {
  fx = await makeGitFixture();
  await commitFile(fx.root, 'keep.txt', 'one\ntwo\n', 'seed keep');
  await commitFile(fx.root, 'gone.txt', 'bye\n', 'seed gone');
});
afterEach(async () => { await fx.cleanup(); });

async function branchWithWork(): Promise<string> {
  // Inside the fixture, so its cleanup removes the worktree too.
  const wt = join(fx.root, '.wt');
  await $`git worktree add -q -b cw/work ${wt}`.cwd(fx.root).quiet();
  await commitFile(wt, 'keep.txt', 'one\nTWO\nthree\n', 'edit keep');
  await commitFile(wt, 'src/new.ts', 'export const x = 1;\n', 'add new');
  await $`git rm -q gone.txt`.cwd(wt).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m drop`.cwd(wt).quiet();
  return wt;
}

describe('sessionDiff', () => {
  // What land would merge: the branch's commits since it left the base — not the
  // base's own later commits, which a plain `base..branch` diff would show reversed.
  it('lists what the branch changed since it left the base, with line counts', async () => {
    const wt = await branchWithWork();
    await commitFile(fx.root, 'later-on-main.txt', 'x\n', 'main moves on');
    const diff = sessionDiff(fx.root, 'cw/work', wt);
    expect(diff.files).toEqual([
      { path: 'gone.txt', status: 'deleted', added: 0, deleted: 1 },
      { path: 'keep.txt', status: 'modified', added: 2, deleted: 1 },
      { path: 'src/new.ts', status: 'added', added: 1, deleted: 0 },
    ]);
    expect(diff.patch).toContain('+TWO');
    expect(diff.patch).not.toContain('later-on-main');
    expect(diff.truncated).toBe(false);
    expect(diff.uncommitted).toBe(0);
  });

  // Land takes commits only: edits still sitting in the worktree are not part of it,
  // and the pane must say so rather than let them look landed.
  it('counts uncommitted files separately, since landing will not take them', async () => {
    const wt = await branchWithWork();
    writeFileSync(join(wt, 'keep.txt'), 'dirty\n');
    writeFileSync(join(wt, 'scratch.md'), 'notes\n');
    expect(sessionDiff(fx.root, 'cw/work', wt).uncommitted).toBe(2);
  });

  it('is empty for a branch with no commits yet', async () => {
    await $`git branch cw/fresh`.cwd(fx.root).quiet();
    const diff = sessionDiff(fx.root, 'cw/fresh', null);
    expect(diff.files).toEqual([]);
    expect(diff.patch).toBe('');
  });

  it('caps a huge patch and says it did', async () => {
    const wt = await branchWithWork();
    await commitFile(wt, 'big.txt', `${'y'.repeat(80)}\n`.repeat(20_000), 'big');
    const diff = sessionDiff(fx.root, 'cw/work', wt, { maxPatchBytes: 64 * 1024 });
    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.patch)).toBeLessThanOrEqual(64 * 1024);
    expect(diff.files.some((f) => f.path === 'big.txt')).toBe(true);
  });

  it('refuses a branch that does not exist', () => {
    expect(() => sessionDiff(fx.root, 'cw/nope', null)).toThrow(expect.objectContaining({ code: 'DIFF_UNAVAILABLE' }));
  });
});
