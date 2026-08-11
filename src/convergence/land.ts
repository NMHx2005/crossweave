import { execFileSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../core/errors.js';
import type { CrossweaveConfig } from '../core/config.js';
import type { SessionRepo } from '../db/repositories/session.js';
import type { LeaseManager } from '../isolation/leases/manager.js';
import type { EventLedger } from '../domain/ledger.js';
import { removeWorktree, deleteBranch } from '../isolation/worktree.js';
import { ensureIntegrationWorktree, withIntegrationLease, withIntegrationWorktreeLock } from './integration-worktree.js';
import { runMergeTrial, resetIntegration } from './trial.js';

export interface LandDeps {
  db: Database;
  projectRoot: string;
  sessions: SessionRepo;
  leaseManager: LeaseManager;
  ledger: EventLedger;
  config: CrossweaveConfig;
}

export interface LandResult {
  status: 'landed';
  tested: 'clean' | 'unverified';
  /** The branch the session was actually landed into — whatever the main checkout had checked out. */
  baseBranch: string;
  /** Non-fatal cleanup failures (stale worktree/branch) the caller should surface, not silently drop. */
  warnings: string[];
}

/**
 * Guards against two `land.session` RPCs racing each other for the SAME workspace —
 * the daemon dispatches socket messages unserialized, and without this, two concurrent
 * lands could both validate against the same base and then both mutate the main
 * checkout, the second one merging a branch that was only ever trialed against a base
 * the first one had already moved past. Exactly the `starting` Set pattern
 * `src/daemon/methods.ts`'s `session.start` already uses for the analogous race.
 */
const landing = new Set<string>();

function currentBaseHead(projectRoot: string): string {
  return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
}

function currentBaseBranch(projectRoot: string): string {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  if (branch === 'HEAD') {
    throw new CrossweaveError('LAND_NO_BASE_BRANCH', 'Cannot land: the project root is on a detached HEAD.');
  }
  return branch;
}

/**
 * `.crossweave/` (worktrees, leases, the daemon socket, and the integration scratch
 * worktree this very module manages) lives inside `projectRoot` by design and is
 * untracked — `git status --porcelain` reports it exactly like any other untracked
 * directory the moment `ensureIntegrationWorktree` first creates it, which happens on
 * ordinary use, not just an error case. Treating that as "the user has uncommitted
 * work" would make `LAND_DIRTY_TREE` fire on effectively every land after the first
 * one in a session's lifetime — it is this tool's own infrastructure, never the
 * user's, so status lines under it are filtered out before deciding cleanliness.
 */
function isWorkingTreeClean(projectRoot: string): boolean {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' });
  const dirty = out
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line) => {
      const path = line.slice(3);
      return path !== '.crossweave' && !path.startsWith('.crossweave/');
    });
  return dirty.length === 0;
}

function bufferText(raw: Buffer | string | undefined): string {
  const text = typeof raw === 'string' ? raw : raw?.toString('utf8');
  return text?.trim() ?? '';
}

/**
 * `execFileSync` attaches `stdout`/`stderr` buffers to the error it throws when the
 * child exits non-zero — pulling the real git message out of that is what turns a bare
 * "Command failed: git merge --squash cw/b" into something the user can act on.
 *
 * Both are checked, stderr first, because WHICH stream git writes its actual message
 * to differs by command: `git rebase`'s conflict output goes to stderr, but `git
 * merge` (both `--squash` and plain `--no-ff`) writes its "CONFLICT (content)..."
 * output to STDOUT, leaving stderr empty — verified directly, not assumed. Reading
 * stderr alone would silently drop the real message for the two most common
 * merge-failure causes and fall back to a bare "Command failed: ...".
 */
function gitStderr(cause: unknown): string {
  const err = cause as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  const stderrText = bufferText(err.stderr);
  const stdoutText = bufferText(err.stdout);
  const text = stderrText.length > 0 ? stderrText : stdoutText;
  return text.length > 0 ? text : (err.message ?? String(cause));
}

/** Every git call that can leave the MAIN checkout mid-conflict captures stderr, not `stdio: 'ignore'`. */
function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * How many commits `branch` has beyond `base` — i.e. whether there is anything for a
 * merge strategy to actually integrate. A session that is `idle` with a real branch
 * but has made no commits yet (e.g. just created, never touched) is a legitimate,
 * already-landable no-op: its content already equals base.
 */
function commitsAhead(projectRoot: string, base: string, branch: string): number {
  const out = execFileSync('git', ['rev-list', '--count', `${base}..${branch}`], {
    cwd: projectRoot, encoding: 'utf8',
  }).trim();
  return Number(out);
}

/**
 * Recovers the main checkout from a failed real merge/squash/ff-only and re-throws as
 * a reportable error. `git reset --hard <base>` is used deliberately instead of
 * `git merge --abort`: a squash merge never sets `MERGE_HEAD`, so `merge --abort`
 * reports "There is no merge to abort" and leaves conflict markers in tracked files —
 * a hard reset is the one recovery that correctly undoes all three strategies' failure
 * modes (squash conflict, plain merge conflict, or a bad post-rebase ff-only).
 */
function recoverMainCheckoutAndFail(projectRoot: string, base: string, cause: unknown): never {
  try {
    execFileSync('git', ['reset', '--hard', base], { cwd: projectRoot, stdio: 'ignore' });
  } catch {
    // Best effort: if even a hard reset fails, the checkout needs manual git
    // intervention — nothing else this function can safely attempt automatically.
  }
  throw new CrossweaveError('LAND_MERGE_FAILED', gitStderr(cause));
}

/**
 * The terminal operation of the whole product: gets a session's branch into the base
 * branch, for real, in the MAIN checkout (never the scratch worktree, which only ever
 * holds a throwaway trial). See the M4 design doc §9 for the 5-step contract this
 * implements.
 */
export async function landSession(
  deps: LandDeps,
  workspaceId: string,
  sessionId: string,
  opts: { force: boolean },
): Promise<LandResult> {
  // Synchronous check-and-add, before the first `await` below: see the `landing`
  // comment above for why this closes the concurrent-land race.
  if (landing.has(workspaceId)) {
    throw new CrossweaveError('LAND_IN_PROGRESS', 'Another land is already in progress for this workspace.');
  }
  landing.add(workspaceId);
  try {
    const row = deps.sessions.findById(sessionId);
    if (!row || row.workspaceId !== workspaceId || row.agentKind === 'integration') {
      // The integration row resolves by id like any other session row, but it
      // is infrastructure, not a landable unit of work — treated as not
      // found rather than given its own error code, matching how it is
      // invisible everywhere else (SessionManager.list, cw session list).
      throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
    }
    if (row.branch === null) {
      throw new CrossweaveError('LAND_NO_BRANCH', `Session ${row.name} has no branch to land (started with --no-worktree).`);
    }
    // Narrowed once, here, into its own binding: TS does not carry a `row.branch
    // !== null` narrowing into the async closure passed to
    // `withIntegrationWorktreeLock` below (a closure handed to another function
    // is not provably synchronous), so every reference below uses this instead.
    const branch: string = row.branch;
    if (row.status === 'running' && !opts.force) {
      throw new CrossweaveError('SESSION_STILL_LIVE', `Session ${row.name} is running. Stop it first, or pass --force.`);
    }
    // Before ANY mutation, even capturing `base`: `git merge --squash` stages its
    // result on top of whatever is already staged/dirty, and the commit right after
    // it would sweep unrelated uncommitted work into the land commit silently.
    if (!isWorkingTreeClean(deps.projectRoot)) {
      throw new CrossweaveError(
        'LAND_DIRTY_TREE',
        'The main checkout has uncommitted changes. Commit or stash them before landing.',
      );
    }

    const base = currentBaseHead(deps.projectRoot);
    const integration = await ensureIntegrationWorktree(deps.db, workspaceId, deps.projectRoot);

    // The scheduler drives this SAME scratch worktree independently (pairwise
    // trials, full-integration runs) on its own 5s timer. Without this lock, a
    // tick landing while this land is suspended on a real async yield below (the
    // lease's port allocation, or the test command itself) would reset/overwrite
    // the merged state this land is testing — and the reverse, this land resetting
    // a scheduler trial mid-flight. `landing` above only rules out a second
    // CONCURRENT `cw land`; this rules out a `cw land` racing the scheduler.
    const { tested, baseBranch } = await withIntegrationWorktreeLock(workspaceId, async () => {
      let tested: 'clean' | 'unverified' = 'unverified';
      let baseBranch: string;
      try {
        const trial = await runMergeTrial(integration.path, base, [branch]);
        if (trial.result === 'conflict') {
          throw new CrossweaveError(
            'LAND_CONFLICT',
            `Session ${row.name}'s branch conflicts with the current base: ${trial.detail ?? '(no files reported)'}`,
          );
        }

        if (deps.config.converge.testCommand !== undefined) {
          const testOutcome = await withIntegrationLease(deps.leaseManager, integration.sessionId, async (env) => {
            // Mirrors the scheduler's `maybeRunFullIntegration`: the integration
            // row's status reflects a real session's lifecycle — `running` only
            // while it is actually executing something, `idle` the rest of the time.
            deps.sessions.updateStatus(integration.sessionId, 'running', null);
            try {
              const proc = Bun.spawn(['sh', '-c', deps.config.converge.testCommand as string], {
                cwd: integration.path, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe',
              });
              const [code, out, err] = await Promise.all([
                proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
              ]);
              return { code, tail: (out + err).slice(-4000) };
            } finally {
              deps.sessions.updateStatus(integration.sessionId, 'idle', null);
            }
          });
          if (testOutcome.code !== 0) {
            throw new CrossweaveError('LAND_TEST_FAILED', `converge.testCommand failed:\n${testOutcome.tail}`);
          }
          tested = 'clean';
        }

        // `runMergeTrial`'s `--no-commit` merge leaves the integration worktree with
        // staged, uncommitted changes — reused as-is, `rebase`'s `checkout -B cw/trial
        // <branch>` below would refuse ("local changes would be overwritten by
        // checkout") on the ordinary, non-conflicting case of base and the branch
        // touching the same file in different places. This clears that leftover state
        // before the strategy block reuses the worktree; the `finally` below's call
        // to the same function cleans up whatever the strategy block itself does
        // afterward — both calls are needed, for different halves of the operation.
        resetIntegration(integration.path, base);

        // The `landing` lock above rules out another `cw land` racing this one, but
        // not the user (or any other process) moving the base branch by hand while a
        // slow test command was still running against the trial's now-stale snapshot
        // of it — re-check right before the real, main-checkout mutation below.
        const baseNow = currentBaseHead(deps.projectRoot);
        if (baseNow !== base) {
          throw new CrossweaveError(
            'LAND_BASE_MOVED',
            `The base branch moved while landing ${row.name} (was ${base}, now ${baseNow}). Retry the land.`,
          );
        }

        baseBranch = currentBaseBranch(deps.projectRoot); // refuses on a detached HEAD, before any main-checkout mutation

        // A session that is otherwise fully landable (idle, real branch, clean
        // trial) but has made no commits beyond `base` yet has nothing for a merge
        // strategy to integrate — its content already equals base. `merge`/`rebase`
        // both handle this as a harmless no-op ("Already up to date", exit 0), but
        // `squash` (the default) does not: `git merge --squash` reports "nothing to
        // squash" (exit 0) and the follow-up `git commit` then fails on "nothing to
        // commit" (exit 1), turning a legitimate no-op into LAND_MERGE_FAILED. Skip
        // the strategy block entirely rather than special-case squash alone — a
        // branch identical to base needs no merge under ANY strategy.
        if (commitsAhead(deps.projectRoot, base, branch) > 0) {
          const strategy = deps.config.converge.mergeStrategy;
          if (strategy === 'squash') {
            try {
              runGit(['merge', '--squash', branch], deps.projectRoot);
              runGit(['commit', '-m', `${row.name}: squashed from ${branch}`], deps.projectRoot);
            } catch (cause) {
              recoverMainCheckoutAndFail(deps.projectRoot, base, cause);
            }
          } else if (strategy === 'rebase') {
            // Rewritten in the scratch worktree — never the session's own branch,
            // and never the main checkout mid-operation — then fast-forwarded into
            // base. A clean 3-way trial merge does NOT guarantee a clean rebase
            // (rebase replays commits individually; an intermediate state can
            // conflict where the final merged state wouldn't), so this can fail
            // even after `runMergeTrial` above reported clean.
            try {
              runGit(['checkout', '-B', 'cw/trial', branch], integration.path);
              runGit(['rebase', base], integration.path);
            } catch (cause) {
              try {
                execFileSync('git', ['rebase', '--abort'], { cwd: integration.path, stdio: 'ignore' });
              } catch {
                // Nothing to abort, or the abort itself failed — the `finally`
                // below's `resetIntegration` makes a second, independent attempt.
              }
              throw new CrossweaveError('LAND_REBASE_CONFLICT', gitStderr(cause));
            }
            // `git rebase <upstream> <branch>` checks `<branch>` out as a side effect,
            // which the integration worktree can absorb harmlessly but the main
            // checkout must not — so the main checkout only ever does the ff-only.
            try {
              runGit(['merge', '--ff-only', 'cw/trial'], deps.projectRoot);
            } catch (cause) {
              recoverMainCheckoutAndFail(deps.projectRoot, base, cause);
            }
          } else {
            try {
              runGit(['merge', '--no-ff', branch, '-m', `Merge ${row.name} (${branch})`], deps.projectRoot);
            } catch (cause) {
              recoverMainCheckoutAndFail(deps.projectRoot, base, cause);
            }
          }
        }
      } finally {
        // Spans the trial, the optional test run AND the real merge above: the
        // integration worktree must always end up reset, whether the failure (or
        // success) happened in the trial, the test run, or the real merge — the
        // strategy block runs in the MAIN checkout, not here, but `resetIntegration`
        // on the integration path is still exactly what's needed regardless.
        resetIntegration(integration.path, base);
      }
      return { tested, baseBranch };
    });

    deps.leaseManager.release(sessionId);
    const warnings: string[] = [];
    const ownWorktree = row.worktreePath !== null && row.worktreePath !== deps.projectRoot ? row.worktreePath : null;
    if (ownWorktree !== null) {
      try {
        await removeWorktree(deps.projectRoot, ownWorktree);
      } catch (cause) {
        warnings.push(`Could not remove worktree ${ownWorktree}: ${(cause as Error).message}`);
      }
    }
    try {
      await deleteBranch(deps.projectRoot, row.branch);
    } catch (cause) {
      warnings.push(`Could not delete branch ${row.branch}: ${(cause as Error).message}`);
    }

    deps.sessions.updateStatus(sessionId, 'landed', null);
    deps.ledger.append({ sessionId, workspaceId, kind: 'session.landed', payload: '{}' });

    return { status: 'landed', tested, baseBranch, warnings };
  } finally {
    landing.delete(workspaceId);
  }
}
