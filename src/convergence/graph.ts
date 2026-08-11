import type { MergeTrialRow } from '../db/repositories/merge-trial.js';
import type { SessionRow } from '../db/repositories/session.js';

/** branch -> set of branches its LATEST pairwise trial says it conflicts with. */
export function buildConflictGraph(trials: MergeTrialRow[]): Map<string, Set<string>> {
  const latestByPair = new Map<string, MergeTrialRow>();
  for (const trial of trials) {
    if (trial.branches.length !== 2) continue; // pairwise only — full-integration rows don't feed the graph
    const key = [...trial.branches].sort().join('|');
    const existing = latestByPair.get(key);
    if (existing === undefined || trial.ts > existing.ts) latestByPair.set(key, trial);
  }

  const graph = new Map<string, Set<string>>();
  const edge = (a: string, b: string): void => {
    if (!graph.has(a)) graph.set(a, new Set());
    graph.get(a)?.add(b);
  };
  for (const trial of latestByPair.values()) {
    if (trial.result !== 'conflict') continue;
    const [a, b] = trial.branches as [string, string];
    edge(a, b);
    edge(b, a);
  }
  return graph;
}

/**
 * Greedy: merge the branches with the fewest conflicting partners first.
 * Ties break by session creation order (oldest first), matching every
 * other ordering convention in this codebase.
 */
export function recommendOrder(sessions: SessionRow[], graph: Map<string, Set<string>>): SessionRow[] {
  return [...sessions].sort((a, b) => {
    const degreeA = graph.get(a.branch ?? '')?.size ?? 0;
    const degreeB = graph.get(b.branch ?? '')?.size ?? 0;
    if (degreeA !== degreeB) return degreeA - degreeB;
    return a.createdAt.localeCompare(b.createdAt);
  });
}
