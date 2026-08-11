import { execFileSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import type { CrossweaveConfig } from '../core/config.js';
import type { LeaseManager } from '../isolation/leases/manager.js';
import { WorkspaceRepo } from '../db/repositories/workspace.js';
import { SessionRepo, type SessionRow } from '../db/repositories/session.js';
import { MergeTrialRepo } from '../db/repositories/merge-trial.js';
import { ensureIntegrationWorktree, withIntegrationLease } from '../convergence/integration-worktree.js';
import { runMergeTrial, resetIntegration } from '../convergence/trial.js';

const TICK_MS = 5_000;

function currentHead(projectRoot: string, branch: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', branch], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined; // branch gone (session removed mid-tick) — skip it this round
  }
}

function baseHead(projectRoot: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Time-boxed, not event-driven — a trial only cares about COMMITTED state
 * (you cannot `git merge` uncommitted work), so this ticks on an interval
 * and reads branch HEADs directly, unlike Radar's `fs.watch`-driven
 * reaction to working-tree writes.
 *
 * One job runs at a time: the scratch worktree can only run one `git
 * merge` at a time, so `tick()` processes its whole queue of due pairs
 * sequentially before returning, and the next scheduled tick is a no-op if
 * the previous one is still running (guarded by `running`).
 */
export class ConvergenceScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly lastTrialHead = new Map<string, string>(); // branch -> head sha
  private readonly lastTrialAt = new Map<string, number>(); // branch -> ts ms
  private readonly triedPairs = new Set<string>(); // `${branchA}@${headA}|${branchB}@${headB}`, sorted
  // Initialized to construction time, not 0: a literal 0 makes
  // `now - lastFullIntegrationAt < fullIntegrationIntervalMs` false on the
  // very first tick no matter the configured interval (`now` is always
  // enormously larger than any reasonable interval), firing a full
  // integration immediately on every daemon boot regardless of config.
  // Starting the clock at construction makes the FIRST full integration
  // wait a full interval too, same as every one after it.
  private lastFullIntegrationAt = Date.now();

  private readonly workspaces: WorkspaceRepo;
  private readonly sessions: SessionRepo;
  private readonly mergeTrials: MergeTrialRepo;

  constructor(
    private readonly db: Database,
    private readonly projectRoot: string,
    private readonly config: CrossweaveConfig,
    private readonly leaseManager: LeaseManager,
  ) {
    this.workspaces = new WorkspaceRepo(db);
    this.sessions = new SessionRepo(db);
    this.mergeTrials = new MergeTrialRepo(db);
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        process.stderr.write(`crossweave: convergence tick failed: ${String(err)}\n`);
      });
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  private activeBranchSessions(workspaceId: string): SessionRow[] {
    return this.sessions
      .listByWorkspace(workspaceId)
      .filter(
        (s) =>
          s.agentKind !== 'integration' &&
          (s.status === 'running' || s.status === 'idle') &&
          s.worktreePath !== null &&
          s.branch !== null,
      );
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const workspace of this.workspaces.list()) {
        await this.tickWorkspace(workspace.id, workspace.rootPath);
      }
    } finally {
      this.running = false;
    }
  }

  private async tickWorkspace(workspaceId: string, projectRoot: string): Promise<void> {
    const active = this.activeBranchSessions(workspaceId);
    if (active.length < 2) return; // nothing to pair against

    const now = Date.now();
    const due = active.filter((s) => {
      const branch = s.branch as string;
      const head = currentHead(projectRoot, branch);
      if (head === undefined) return false;
      const changed = this.lastTrialHead.get(branch) !== head;
      const cooledDown = now - (this.lastTrialAt.get(branch) ?? 0) >= this.config.converge.trialDebounceMs;
      return changed && cooledDown;
    });
    if (due.length === 0) return;

    if (active.length > this.config.converge.pairwiseSessionThreshold) {
      // Degrade: full-integration only, no pairwise trials at all this round.
      // §5 of the design doc — cw converge status (Task 5) reports this explicitly.
      return;
    }

    const base = baseHead(projectRoot);
    if (base === undefined) return;

    const integration = await ensureIntegrationWorktree(this.db, workspaceId, projectRoot);

    for (const session of due) {
      const branchA = session.branch as string;
      const headA = currentHead(projectRoot, branchA);
      if (headA === undefined) continue;

      for (const partner of active) {
        if (partner.id === session.id) continue;
        const branchB = partner.branch as string;
        const headB = currentHead(projectRoot, branchB);
        if (headB === undefined) continue;

        const pairKey = [`${branchA}@${headA}`, `${branchB}@${headB}`].sort().join('|');
        if (this.triedPairs.has(pairKey)) continue;

        const result = await runMergeTrial(integration.path, base, [branchA, branchB]);
        resetIntegration(integration.path, base);
        this.mergeTrials.insert({
          id: newId('mt'), workspaceId, ts: new Date().toISOString(),
          branches: [branchA, branchB], result: result.result, detail: result.detail,
        });
        this.triedPairs.add(pairKey);
      }

      this.lastTrialHead.set(branchA, headA);
      this.lastTrialAt.set(branchA, now);
    }

    await this.maybeRunFullIntegration(workspaceId, integration.sessionId, integration.path, base, active);
  }

  private async maybeRunFullIntegration(
    workspaceId: string,
    integrationSessionId: string,
    integrationPath: string,
    base: string,
    active: SessionRow[],
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastFullIntegrationAt < this.config.converge.fullIntegrationIntervalMs) return;

    // "a conflicting merge never reaches the test phase" — only proceed if
    // the most recent pairwise trial for every active pair is clean.
    const trials = this.mergeTrials.listByWorkspace(workspaceId).filter((t) => t.branches.length === 2);
    const latestByPair = new Map<string, (typeof trials)[number]>();
    for (const t of trials) latestByPair.set([...t.branches].sort().join('|'), t);
    const branches = active.map((s) => s.branch as string);
    for (let i = 0; i < branches.length; i += 1) {
      for (let j = i + 1; j < branches.length; j += 1) {
        const latest = latestByPair.get([branches[i], branches[j]].sort().join('|'));
        if (latest === undefined || latest.result !== 'clean') return; // unknown or conflicting pair — skip this round
      }
    }

    this.lastFullIntegrationAt = now;
    const result = await runMergeTrial(integrationPath, base, branches);
    if (result.result === 'conflict') {
      resetIntegration(integrationPath, base);
      this.mergeTrials.insert({
        id: newId('mt'), workspaceId, ts: new Date().toISOString(),
        branches, result: 'conflict', detail: result.detail,
      });
      return;
    }

    if (this.config.converge.testCommand === undefined) {
      resetIntegration(integrationPath, base);
      this.mergeTrials.insert({
        id: newId('mt'), workspaceId, ts: new Date().toISOString(),
        branches, result: 'unverified', detail: null,
      });
      return;
    }

    const testResult = await withIntegrationLease(this.leaseManager, integrationSessionId, async (env) => {
      this.sessions.updateStatus(integrationSessionId, 'running', null);
      try {
        const proc = Bun.spawn(['sh', '-c', this.config.converge.testCommand as string], {
          cwd: integrationPath, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe',
        });
        const [code, out, err] = await Promise.all([
          proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
        ]);
        return { code, tail: (out + err).slice(-4000) };
      } finally {
        this.sessions.updateStatus(integrationSessionId, 'idle', null);
      }
    });

    resetIntegration(integrationPath, base);
    this.mergeTrials.insert({
      id: newId('mt'), workspaceId, ts: new Date().toISOString(),
      branches,
      result: testResult.code === 0 ? 'clean' : 'test_fail',
      detail: testResult.code === 0 ? null : testResult.tail,
    });
  }
}
