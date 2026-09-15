import { isPairwiseTrial, type MergeTrialRow } from '../db/repositories/merge-trial.js';

export type Landability = 'ready' | 'unknown' | 'blocked';

export interface SessionEvidenceInput {
  name: string;
  branch: string;
}

export interface ClassifyInput {
  sessions: SessionEvidenceInput[];
  trials: MergeTrialRow[];
  /** `null` when the base branch HEAD could not be read at all — see the loop below. */
  currentBaseHead: string | null;
  degraded: boolean;
  hasTrustedTestCommand: boolean;
  latestFullIntegration: MergeTrialRow | null;
}

export interface SessionLandability {
  name: string;
  landability: Landability;
  reason: string;
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

export function classifyLandability(input: ClassifyInput): {
  byName: Map<string, SessionLandability>;
  ready: string[];
} {
  const currentBaseHead = input.currentBaseHead;
  const activeBranches = new Set(input.sessions.map((session) => session.branch));
  const latestByPair = new Map<string, MergeTrialRow>();
  for (const trial of input.trials) {
    // `isPairwiseTrial`, not `branches.length === 2`: a full-integration trial
    // over exactly 2 active sessions has the same branch count as the genuine
    // pairwise trial for that pair, and being the later row would let it win
    // this latest-by-pair lookup and decide the pair's landability.
    if (
      !isPairwiseTrial(trial)
      || trial.branches.length !== 2
      || !activeBranches.has(trial.branches[0]!)
      || !activeBranches.has(trial.branches[1]!)
    ) {
      continue;
    }
    const key = pairKey(trial.branches[0]!, trial.branches[1]!);
    const existing = latestByPair.get(key);
    if (existing === undefined || trial.ts > existing.ts) latestByPair.set(key, trial);
  }

  const byName = new Map<string, SessionLandability>();
  const ready: string[] = [];

  for (const session of input.sessions) {
    const pairwise = input.sessions
      .filter((other) => other.branch !== session.branch)
      .map((other) => ({ other, trial: latestByPair.get(pairKey(session.branch, other.branch)) }));

    // A conflict only holds a session back while it is evidence about the
    // CURRENT base. Once the base moves (a land, or a manual commit), a recorded
    // conflict says nothing about whether the two branches still collide, so a
    // stale one falls through to the staleness check below and reports `unknown`
    // instead of staying `blocked`. That is the deliberate choice: stale conflict
    // evidence is treated exactly like stale clean evidence, because `unknown` is
    // the state a refreshed trial can clear, while `blocked` reads as a decision
    // the user has to act on and would never clear itself.
    const blocked = pairwise.find(({ trial }) => {
      if (trial === undefined) return false;
      if (trial.result !== 'conflict' && trial.result !== 'test_fail') return false;
      return trial.baseHead === currentBaseHead;
    });
    let landability: Landability;
    let reason: string;

    if (currentBaseHead === null) {
      // Every freshness judgement below is relative to the base HEAD. Without it
      // nothing can be called ready, and nothing can honestly be called blocked
      // either, since no recorded trial can be shown to still apply.
      landability = 'unknown';
      reason = 'the base branch HEAD could not be read';
    } else if (blocked?.trial !== undefined) {
      landability = 'blocked';
      reason = `latest trial with ${blocked.other.name} is ${blocked.trial.result}`;
    } else if (input.degraded) {
      landability = 'unknown';
      reason = 'pairwise convergence checks are disabled in degraded mode';
    } else {
      const missing = pairwise.find(({ trial }) => trial === undefined);
      const stale = pairwise.find(({ trial }) => trial !== undefined && trial.baseHead !== currentBaseHead);
      const notClean = pairwise.find(({ trial }) => trial !== undefined && trial.result !== 'clean');

      if (missing !== undefined) {
        landability = 'unknown';
        reason = `no pairwise trial with ${missing.other.name}`;
      } else if (stale?.trial !== undefined) {
        landability = 'unknown';
        reason = `pairwise trial with ${stale.other.name} is from an older base`;
      } else if (notClean?.trial !== undefined) {
        landability = 'unknown';
        reason = `latest trial with ${notClean.other.name} is ${notClean.trial.result}`;
      } else if (input.hasTrustedTestCommand && input.latestFullIntegration === null) {
        landability = 'unknown';
        reason = 'no full-integration test result';
      } else if (
        input.hasTrustedTestCommand
        && input.latestFullIntegration?.baseHead !== currentBaseHead
      ) {
        landability = 'unknown';
        reason = 'full-integration test is from an older base';
      } else if (
        input.hasTrustedTestCommand
        && input.latestFullIntegration?.result !== 'clean'
      ) {
        landability = 'unknown';
        reason = `latest full-integration test is ${input.latestFullIntegration?.result}`;
      } else {
        landability = 'ready';
        reason = 'all required convergence evidence is fresh and clean';
      }
    }

    const result = { name: session.name, landability, reason };
    byName.set(session.name, result);
    if (landability === 'ready') ready.push(session.name);
  }

  return { byName, ready };
}
