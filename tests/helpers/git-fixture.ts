import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readdirSync, realpathSync, rmSync } from 'node:fs';
import { $ } from 'bun';

export interface GitFixture {
  root: string;
  cleanup: () => Promise<void>;
}

let template: string | undefined;

const TEMPLATE_NAME = /^cw-template-(\d+)-/;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process — dead. EPERM: exists but owned by someone else — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes `cw-template-<pid>-*` directories in `dir` whose owning pid is no longer
 * alive. Anything that doesn't match the expected name shape is left alone — better to
 * miss a stale directory than to guess-delete something that isn't ours.
 *
 * `bun test` does not run `process.once('exit', ...)` handlers on its own natural
 * termination (confirmed empirically — neither `exit` nor `beforeExit` fire, even via
 * `--preload`; only an explicit `process.exit()` call triggers them), so that handler
 * below cannot be relied on to clean up a `bun test` process's own template. This sweep
 * is what actually bounds the leak: a dead process's template is removed the next time
 * *any* process calls `gitTemplate()`, which for `bun test` is the next test run.
 */
export function sweepStaleTemplates(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = TEMPLATE_NAME.exec(name);
    if (!match?.[1]) continue;
    const pid = Number(match[1]);
    if (isAlive(pid)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      // Best effort — another sweep or the owning process may have already removed it.
    }
  }
}

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
  sweepStaleTemplates(tmpdir());
  const root = realpathSync(await mkdtemp(join(tmpdir(), `cw-template-${process.pid}-`)));
  await $`git init -q -b main`.cwd(root).quiet();
  await $`git config user.email test@crossweave.dev`.cwd(root).quiet();
  await $`git config user.name ${'crossweave test'}`.cwd(root).quiet();
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await $`git add .`.cwd(root).quiet();
  await $`git commit -q -m init`.cwd(root).quiet();
  template = root;
  // Removed when the process exits, on runtimes that actually fire this — see the
  // sweep above for why `bun test` itself needs the startup sweep instead.
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

/** Writes, adds and commits a file inside `repoRoot`. Returns the new commit's hash. */
export async function commitFile(
  repoRoot: string,
  relativePath: string,
  content: string,
  message: string,
): Promise<string> {
  const fullPath = join(repoRoot, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  await $`git add ${relativePath}`.cwd(repoRoot).quiet();
  await $`git commit -q -m ${message}`.cwd(repoRoot).quiet();
  return (await $`git rev-parse HEAD`.cwd(repoRoot).quiet().text()).trim();
}
