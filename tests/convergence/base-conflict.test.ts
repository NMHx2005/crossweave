import { describe, it, expect } from 'bun:test';
import { $ } from 'bun';
import { baseConflictFiles } from '../../src/convergence/trial.js';
import { makeGitFixture, commitFile } from '../helpers/git-fixture.js';

describe('baseConflictFiles', () => {
  it('names the files a branch conflicts on against the base, and nothing when it merges cleanly', async () => {
    const fx = await makeGitFixture();
    try {
      await commitFile(fx.root, 'shared.txt', 'base\n', 'seed');
      await $`git checkout -q -b cw/clash`.cwd(fx.root).quiet();
      await commitFile(fx.root, 'shared.txt', 'from branch\n', 'branch edit');
      await $`git checkout -q main`.cwd(fx.root).quiet();
      await $`git checkout -q -b cw/fine`.cwd(fx.root).quiet();
      await commitFile(fx.root, 'other.txt', 'new\n', 'unrelated');
      await $`git checkout -q main`.cwd(fx.root).quiet();
      await commitFile(fx.root, 'shared.txt', 'from main\n', 'main edit');
      const base = (await $`git rev-parse HEAD`.cwd(fx.root).quiet().text()).trim();

      expect(baseConflictFiles(fx.root, base, 'cw/clash')).toEqual(['shared.txt']);
      expect(baseConflictFiles(fx.root, base, 'cw/fine')).toEqual([]);
    } finally {
      await fx.cleanup();
    }
  });

  it('answers undefined, not "clean", when git cannot tell', async () => {
    const fx = await makeGitFixture();
    try {
      expect(baseConflictFiles(fx.root, 'HEAD', 'no-such-branch')).toBeUndefined();
    } finally {
      await fx.cleanup();
    }
  });
});
