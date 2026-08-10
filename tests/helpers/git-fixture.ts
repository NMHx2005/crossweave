import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync, rmSync } from 'node:fs';
import { $ } from 'bun';

export interface GitFixture {
  root: string;
  cleanup: () => Promise<void>;
}

let template: string | undefined;

/**
 * Built once per process, then copied per fixture.
 *
 * Creating it per test meant six git subprocesses inside `beforeEach`, against Bun's
 * 5s default hook timeout. Under load that chain exceeded it: the same seven
 * isolation tests measured 934ms, 1112ms and 7.43s across three consecutive runs, and
 * a gate run failed outright with "a beforeEach/afterEach hook timed out". A
 * directory copy is one syscall-bound operation instead.
 */
async function gitTemplate(): Promise<string> {
  if (template !== undefined) return template;
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'cw-template-')));
  await $`git init -q -b main`.cwd(root).quiet();
  await $`git config user.email test@crossweave.dev`.cwd(root).quiet();
  await $`git config user.name ${'crossweave test'}`.cwd(root).quiet();
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await $`git add .`.cwd(root).quiet();
  await $`git commit -q -m init`.cwd(root).quiet();
  template = root;
  // One template per process, removed when the process exits. Without this every
  // test run leaves a live git repo in TMPDIR; a full TMPDIR is what caused M0's
  // beforeEach hook timeouts in the first place.
  process.once('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort on exit; a leftover template is not worth failing a run over.
    }
  });
  return root;
}

/** A temp git repo with one commit on `main`. */
export async function makeGitFixture(): Promise<GitFixture> {
  const src = await gitTemplate();
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'cw-git-')));
  // The template has no worktrees, so its .git holds no absolute paths and copies
  // cleanly. Anything that adds a worktree to the TEMPLATE would break that.
  await cp(src, root, { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
