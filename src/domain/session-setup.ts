import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Session setup hooks. `sessionSetup` warms a fresh worktree (install, seed, env); it is
 * TYPED into the session's shell at its first start, not spawned by the daemon — that is
 * the only way its output lands in the pty the user is looking at, and it runs in the
 * user's own login shell (aliases, PATH). `sessionTeardown` is the opposite: there is no
 * shell left to type into when a worktree is removed, so the daemon spawns it, best
 * effort. Both are arbitrary shell from a repo-controlled file and must be trusted first
 * (see src/convergence/trust.ts) — nothing here checks that, the caller does.
 */

export type SetupSkip = 'not-configured' | 'no-worktree' | 'already-ran' | 'untrusted';

export interface SetupDecision {
  /** The hook line to type, when it should run now. */
  command?: string;
  /** True only when `command` is set: a skipped hook must not be recorded as run. */
  mark: boolean;
  /** Why a configured hook will not run. */
  skipped?: SetupSkip;
}

export interface SetupInput {
  hooks: { sessionSetup?: string } | undefined;
  trusted: boolean;
  alreadyRan: boolean;
  hasWorktree: boolean;
}

export function decideSetup(input: SetupInput): SetupDecision {
  const command = input.hooks?.sessionSetup;
  if (command === undefined) return { mark: false, skipped: 'not-configured' };
  if (!input.hasWorktree) return { mark: false, skipped: 'no-worktree' };
  if (input.alreadyRan) return { mark: false, skipped: 'already-ran' };
  if (!input.trusted) return { mark: false, skipped: 'untrusted' };
  return { command, mark: true };
}

/** `setup && run`: a failed setup must not start the launcher on a half-installed tree. */
export function withSetup(command: string, run: string | undefined): string {
  return run === undefined ? command : `${command} && ${run}`;
}

/**
 * Typed as a shell comment, so it runs nothing and only tells the user why setup was
 * skipped. Its own line — a trailing `# … && run` would comment the run away too.
 */
export const SETUP_UNTRUSTED_NOTICE =
  '# crossweave: hooks.sessionSetup is set but NOT trusted — run `cw config trust hooks` to allow it';

/**
 * Runs `sessionTeardown` before a worktree is removed. Best effort by design: a failing
 * teardown must never block the removal, so it returns a warning to surface (or undefined
 * when it was fine) rather than throwing.
 */
export function runTeardown(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<string | undefined> {
  if (!existsSync(cwd)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'sh',
      ['-c', command],
      { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err === null || err === undefined) {
          resolve(undefined);
          return;
        }
        const tail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ');
        resolve(`sessionTeardown failed: ${tail !== '' ? tail : err.message}`);
      },
    );
  });
}
