import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { $ } from 'bun';

export interface GitFixture {
  root: string;
  cleanup: () => Promise<void>;
}

/** A temp git repo with one commit on `main`. */
export async function makeGitFixture(): Promise<GitFixture> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'cw-git-')));
  await $`git init -q -b main`.cwd(root).quiet();
  await $`git config user.email test@crossweave.dev`.cwd(root).quiet();
  await $`git config user.name ${'crossweave test'}`.cwd(root).quiet();
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await $`git add .`.cwd(root).quiet();
  await $`git commit -q -m init`.cwd(root).quiet();
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
