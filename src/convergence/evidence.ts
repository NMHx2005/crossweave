import type { MergeTrialRow } from '../db/repositories/merge-trial.js';

export type Landability = 'ready' | 'unknown' | 'blocked';

export interface SessionEvidenceInput {
  name: string;
  branch: string;
}

export interface ClassifyInput {
  sessions: SessionEvidenceInput[];
  trials: MergeTrialRow[];
  currentBaseHead: string;
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
  const activeBranches = new Set(input.sessions.map((session) => session.branch));
  const latestByPair = new Map<string, MergeTrialRow>();
  for (const trial of input.trials) {
    if (
      trial.branches.length !== 2
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

    const blocked = pairwise.find(
      ({ trial }) => trial?.result === 'conflict' || trial?.result === 'test_fail',
    );
    let landability: Landability;
    let reason: string;

    if (blocked?.trial !== undefined) {
      landability = 'blocked';
      reason = `latest trial with ${blocked.other.name} is ${blocked.trial.result}`;
    } else if (input.degraded) {
      landability = 'unknown';
      reason = 'pairwise convergence checks are disabled in degraded mode';
    } else {
      const missing = pairwise.find(({ trial }) => trial === undefined);
      const stale = pairwise.find(({ trial }) => trial !== undefined && trial.baseHead !== input.currentBaseHead);
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
        && input.latestFullIntegration?.baseHead !== input.currentBaseHead
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
