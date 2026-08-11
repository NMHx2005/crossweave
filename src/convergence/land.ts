import { execFileSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../core/errors.js';
import type { CrossweaveConfig } from '../core/config.js';
import type { SessionRepo } from '../db/repositories/session.js';
import type { LeaseManager } from '../isolation/leases/manager.js';
import type { EventLedger } from '../domain/ledger.js';
import { removeWorktree, deleteBranch } from '../isolation/worktree.js';
import { ensureIntegrationWorktree, withIntegrationLease } from './integration-worktree.js';
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
}

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
 * The terminal operation of the whole product: gets a session's branch
 * into the base branch, for real, in the MAIN checkout (never the scratch
 * worktree, which only ever holds a throwaway trial). See the M4 design
 * doc §9 for the 5-step contract this implements.
 */
export async function landSession(
  deps: LandDeps,
  workspaceId: string,
  sessionId: string,
  opts: { force: boolean },
): Promise<LandResult> {
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
  if (row.status === 'running' && !opts.force) {
    throw new CrossweaveError('SESSION_STILL_LIVE', `Session ${row.name} is running. Stop it first, or pass --force.`);
  }

  const base = currentBaseHead(deps.projectRoot);
  const integration = await ensureIntegrationWorktree(deps.db, workspaceId, deps.projectRoot);

  const trial = await runMergeTrial(integration.path, base, [row.branch]);
  if (trial.result === 'conflict') {
    resetIntegration(integration.path, base);
    throw new CrossweaveError(
      'LAND_CONFLICT',
      `Session ${row.name}'s branch conflicts with the current base: ${trial.detail ?? '(no files reported)'}`,
    );
  }

  let tested: 'clean' | 'unverified' = 'unverified';
  if (deps.config.converge.testCommand !== undefined) {
    const testOutcome = await withIntegrationLease(deps.leaseManager, integration.sessionId, async (env) => {
      const proc = Bun.spawn(['sh', '-c', deps.config.converge.testCommand as string], {
        cwd: integration.path, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe',
      });
      const [code, out, err] = await Promise.all([
        proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ]);
      return { code, tail: (out + err).slice(-4000) };
    });
    if (testOutcome.code !== 0) {
      resetIntegration(integration.path, base);
      throw new CrossweaveError('LAND_TEST_FAILED', `converge.testCommand failed:\n${testOutcome.tail}`);
    }
    tested = 'clean';
  }
  resetIntegration(integration.path, base);

  currentBaseBranch(deps.projectRoot); // refuses on a detached HEAD before any git mutation below

  const strategy = deps.config.converge.mergeStrategy;
  if (strategy === 'squash') {
    execFileSync('git', ['merge', '--squash', row.branch], { cwd: deps.projectRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', `${row.name}: squashed from ${row.branch}`], { cwd: deps.projectRoot, stdio: 'ignore' });
  } else if (strategy === 'rebase') {
    // Rewritten in the scratch worktree — never the session's own branch,
    // and never the main checkout mid-operation — then fast-forwarded into
    // base. `git rebase <upstream> <branch>` checks `<branch>` out as a
    // side effect, which the integration worktree can absorb harmlessly
    // but the main checkout must not.
    execFileSync('git', ['checkout', '-B', 'cw/trial', row.branch], { cwd: integration.path, stdio: 'ignore' });
    execFileSync('git', ['rebase', base], { cwd: integration.path, stdio: 'ignore' });
    execFileSync('git', ['merge', '--ff-only', 'cw/trial'], { cwd: deps.projectRoot, stdio: 'ignore' });
    resetIntegration(integration.path, base);
  } else {
    execFileSync('git', ['merge', '--no-ff', row.branch, '-m', `Merge ${row.name} (${row.branch})`], {
      cwd: deps.projectRoot, stdio: 'ignore',
    });
  }

  deps.leaseManager.release(sessionId);
  const ownWorktree = row.worktreePath !== null && row.worktreePath !== deps.projectRoot ? row.worktreePath : null;
  if (ownWorktree !== null) {
    await removeWorktree(deps.projectRoot, ownWorktree).catch(() => undefined);
  }
  await deleteBranch(deps.projectRoot, row.branch).catch(() => undefined);

  deps.sessions.updateStatus(sessionId, 'landed', null);
  deps.ledger.append({ sessionId, workspaceId, kind: 'session.landed', payload: '{}' });

  return { status: 'landed', tested };
}
