import { execFileSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import type { CrossweaveConfig } from '../core/config.js';
import type { LeaseManager } from '../isolation/leases/manager.js';
import { WorkspaceRepo } from '../db/repositories/workspace.js';
import { SessionRepo, type SessionRow } from '../db/repositories/session.js';
import { MergeTrialRepo } from '../db/repositories/merge-trial.js';
import { ensureIntegrationWorktree, withIntegrationLease, withIntegrationWorktreeLock } from '../convergence/integration-worktree.js';
import { runMergeTrial, resetIntegration } from '../convergence/trial.js';

const TICK_MS = 5_000;
// Sorted-pair dedup keys accumulate one entry per unique (branch@head, branch@head)
// combination ever trialled and are never individually superseded (unlike
// lastTrialHead/lastTrialAt, which overwrite per branch). Capped with simple FIFO
// eviction so a long-running daemon's memory doesn't grow without bound.
const MAX_TRIED_PAIRS = 5_000;

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
  // Keyed `${workspaceId}:${branch}` — two workspaces can each have a
  // same-named branch (branch names derive from session names), and a bare
  // branch key would let one workspace's trial silently mark the other
  // workspace's identically-named branch as already-trialled.
  private readonly lastTrialHead = new Map<string, string>(); // workspaceId:branch -> head sha
  private readonly lastTrialAt = new Map<string, number>(); // workspaceId:branch -> ts ms
  private readonly triedPairs = new Set<string>(); // `${workspaceId}:${branchA}@${headA}|${branchB}@${headB}`, pair sorted
  // Keyed by workspaceId — a single shared scalar let one workspace's full
  // integration reset the clock for every OTHER workspace too, so the
  // oldest workspace (by WorkspaceRepo.list()'s created_at ASC order)
  // always won the shared interval and every later workspace silently
  // never got a full-integration trial. `constructedAt` is the same
  // "initialized to construction time, not 0" default this map falls back
  // to per-workspace the first time it's checked: a literal 0 would make
  // `now - 0 < fullIntegrationIntervalMs` false no matter the configured
  // interval (`now` is always enormously larger than any reasonable
  // interval), firing a full integration immediately on every daemon boot
  // regardless of config. Falling back to construction time makes each
  // workspace's FIRST full integration wait a full interval too, same as
  // every one after it — independently of every other workspace.
  private readonly lastFullIntegrationAt = new Map<string, number>(); // workspaceId -> ts ms
  private readonly constructedAt = Date.now();

  private readonly workspaces: WorkspaceRepo;
  private readonly sessions: SessionRepo;
  private readonly mergeTrials: MergeTrialRepo;

  constructor(
    private readonly db: Database,
    projectRoot: string,
    private readonly config: CrossweaveConfig,
    private readonly leaseManager: LeaseManager,
  ) {
    this.workspaces = new WorkspaceRepo(db);
    this.sessions = new SessionRepo(db);
    this.mergeTrials = new MergeTrialRepo(db);
  }

  start(): void {
    // A second start() before stop() would silently overwrite `this.timer`,
    // leaking the first interval (nothing could ever clear it again).
    if (this.timer !== undefined) clearInterval(this.timer);
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
        try {
          await this.tickWorkspace(workspace.id, workspace.rootPath);
        } catch (err) {
          // A deterministic failure at one workspace (e.g. a broken
          // integration worktree) must not starve every OTHER workspace of
          // every future tick — letting it escape here would do exactly
          // that, since the outer catch in start() drops the whole tick.
          process.stderr.write(`crossweave: convergence tick failed for ${workspace.id}: ${String(err)}\n`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private rememberPair(key: string): void {
    this.triedPairs.add(key);
    if (this.triedPairs.size > MAX_TRIED_PAIRS) {
      const oldest = this.triedPairs.values().next().value;
      if (oldest !== undefined) this.triedPairs.delete(oldest);
    }
  }

  private async tickWorkspace(workspaceId: string, projectRoot: string): Promise<void> {
    const active = this.activeBranchSessions(workspaceId);
    if (active.length < 2) return; // nothing to pair against

    // Above the threshold, pairwise trials are O(n^2) git merges every tick —
    // too expensive to run at all. Degrade to full-integration only: skip the
    // pairwise section entirely (no trials recorded), but still let
    // maybeRunFullIntegration run, with its own all-pairs-clean gate
    // bypassed since degraded mode never produces the pairwise evidence that
    // gate looks for. §5 of the design doc — `cw converge status` (Task 5)
    // reports this explicitly.
    const degraded = active.length > this.config.converge.pairwiseSessionThreshold;

    const now = Date.now();
    let due: SessionRow[] = [];
    if (!degraded) {
      due = active.filter((s) => {
        const branch = s.branch as string;
        const head = currentHead(projectRoot, branch);
        if (head === undefined) return false;
        const key = `${workspaceId}:${branch}`;
        const changed = this.lastTrialHead.get(key) !== head;
        const cooledDown = now - (this.lastTrialAt.get(key) ?? 0) >= this.config.converge.trialDebounceMs;
        return changed && cooledDown;
      });
      if (due.length === 0) return;
    }

    const base = baseHead(projectRoot);
    if (base === undefined) return;

    const integration = await ensureIntegrationWorktree(this.db, workspaceId, projectRoot);

    if (!degraded) {
      // The whole pairwise sweep runs under one lock acquisition per tickWorkspace
      // call — every mutation of the shared integration worktree below (the trial
      // merge and its reset) must not interleave with another workspace-scoped
      // caller (a concurrent `cw land`, or this same lock's next acquisition by
      // `maybeRunFullIntegration` below) touching the SAME worktree mid-trial.
      await withIntegrationWorktreeLock(workspaceId, async () => {
        for (const session of due) {
          const branchA = session.branch as string;
          const headA = currentHead(projectRoot, branchA);
          if (headA === undefined) continue;

          for (const partner of active) {
            if (partner.id === session.id) continue;
            const branchB = partner.branch as string;
            const headB = currentHead(projectRoot, branchB);
            if (headB === undefined) continue;

            const pairKey = `${workspaceId}:${[`${branchA}@${headA}`, `${branchB}@${headB}`].sort().join('|')}`;
            if (this.triedPairs.has(pairKey)) continue;

            const result = await runMergeTrial(integration.path, base, [branchA, branchB]);
            resetIntegration(integration.path, base);
            this.mergeTrials.insert({
              id: newId('mt'), workspaceId, ts: new Date().toISOString(),
              branches: [branchA, branchB], result: result.result, detail: result.detail,
            });
            this.rememberPair(pairKey);
          }

          this.lastTrialHead.set(`${workspaceId}:${branchA}`, headA);
          this.lastTrialAt.set(`${workspaceId}:${branchA}`, now);
        }
      });
    }

    await this.maybeRunFullIntegration(workspaceId, integration.sessionId, integration.path, base, active, degraded);
  }

  private async maybeRunFullIntegration(
    workspaceId: string,
    integrationSessionId: string,
    integrationPath: string,
    base: string,
    active: SessionRow[],
    degraded: boolean,
  ): Promise<void> {
    const now = Date.now();
    const last = this.lastFullIntegrationAt.get(workspaceId) ?? this.constructedAt;
    if (now - last < this.config.converge.fullIntegrationIntervalMs) return;

    const branches = active.map((s) => s.branch as string);

    if (!degraded) {
      // "a conflicting merge never reaches the test phase" — only proceed if
      // the most recent pairwise trial for every active pair is clean.
      const trials = this.mergeTrials.listByWorkspace(workspaceId).filter((t) => t.branches.length === 2);
      const latestByPair = new Map<string, (typeof trials)[number]>();
      for (const t of trials) latestByPair.set([...t.branches].sort().join('|'), t);
      for (let i = 0; i < branches.length; i += 1) {
        for (let j = i + 1; j < branches.length; j += 1) {
          const latest = latestByPair.get([branches[i], branches[j]].sort().join('|'));
          if (latest === undefined || latest.result !== 'clean') return; // unknown or conflicting pair — skip this round
        }
      }
    }
    // Degraded mode has no pairwise evidence to check at all — that's
    // expected, not a reason to refuse. The full-integration trial's own
    // conflict check below still protects against wasting a test run on a
    // conflicting merge.

    this.lastFullIntegrationAt.set(workspaceId, now);
    // The whole trial-through-test-through-reset sequence runs under one lock
    // acquisition: `withIntegrationLease`'s port allocation is a genuine async
    // yield (real network I/O), and the test command itself can run for a long
    // time — both must hold this workspace's integration worktree exclusively for
    // their entire duration, not just around the synchronous git calls, or a
    // concurrent `cw land` (or the next tick's pairwise sweep) could reset/overwrite
    // the merged state this full-integration run is still testing against.
    await withIntegrationWorktreeLock(workspaceId, async () => {
      try {
        const result = await runMergeTrial(integrationPath, base, branches);
        if (result.result === 'conflict') {
          this.mergeTrials.insert({
            id: newId('mt'), workspaceId, ts: new Date().toISOString(),
            branches, result: 'conflict', detail: result.detail,
          });
          return;
        }

        if (this.config.converge.testCommand === undefined) {
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

        this.mergeTrials.insert({
          id: newId('mt'), workspaceId, ts: new Date().toISOString(),
          branches,
          result: testResult.code === 0 ? 'clean' : 'test_fail',
          detail: testResult.code === 0 ? null : testResult.tail,
        });
      } finally {
        // Covers every exit from the try above, including a throw from
        // runMergeTrial/withIntegrationLease/Bun.spawn itself — previously
        // only the two explicit early-return branches called this, so an
        // unexpected error left the integration worktree dirty for the next
        // trial.
        resetIntegration(integrationPath, base);
      }
    });
  }
}
