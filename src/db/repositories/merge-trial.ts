import type { Database } from 'bun:sqlite';

export type MergeTrialResult = 'clean' | 'conflict' | 'test_fail' | 'unverified';

export interface MergeTrialRow {
  id: string;
  workspaceId: string;
  ts: string;
  branches: string[];
  result: MergeTrialResult;
  detail: string | null;
  baseHead: string;
  /**
   * `true` for a pairwise trial, `false` for a full-integration one, `null` for a
   * row written before schema v11 recorded the kind. Never inferred from
   * `branches.length`: a full-integration trial has exactly 2 branches whenever
   * exactly 2 sessions are active, so the count cannot distinguish them.
   */
  pairwise: boolean | null;
}

interface MergeTrialRecord {
  id: string;
  workspace_id: string;
  ts: string;
  branches: string;
  result: string;
  detail: string | null;
  base_head: string;
  pairwise: number | null;
}

const COLS = 'id,workspace_id,ts,branches,result,detail,base_head,pairwise';

function toRow(r: MergeTrialRecord): MergeTrialRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    ts: r.ts,
    branches: JSON.parse(r.branches) as string[],
    result: r.result as MergeTrialResult,
    detail: r.detail,
    baseHead: r.base_head,
    pairwise: r.pairwise === null ? null : r.pairwise !== 0,
  };
}

/**
 * Whether `row` is a pairwise trial rather than a full-integration one.
 *
 * Rows written before schema v11 carry no recorded kind, and the branch-count
 * heuristic below is the only thing available for them — the same heuristic that
 * classified them when they were written, so nothing about existing history
 * changes. It stays wrong for the one case the `pairwise` column exists to fix (a
 * pre-v11 full-integration trial over exactly 2 branches); that row is unfixable
 * after the fact, and one stale misread pair clears itself on the next trial.
 */
export function isPairwiseTrial(row: MergeTrialRow): boolean {
  return row.pairwise ?? row.branches.length === 2;
}

export class MergeTrialRepo {
  constructor(private readonly db: Database) {}

  insert(row: MergeTrialRow): void {
    this.db
      .prepare(`INSERT INTO merge_trial (${COLS}) VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        row.id, row.workspaceId, row.ts, JSON.stringify(row.branches), row.result, row.detail, row.baseHead,
        row.pairwise === null ? null : Number(row.pairwise),
      );
  }

  listByWorkspace(workspaceId: string): MergeTrialRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM merge_trial WHERE workspace_id=? ORDER BY ts ASC`)
        .all(workspaceId) as MergeTrialRecord[]
    ).map(toRow);
  }
}
