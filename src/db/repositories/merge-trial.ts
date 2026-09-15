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
}

interface MergeTrialRecord {
  id: string;
  workspace_id: string;
  ts: string;
  branches: string;
  result: string;
  detail: string | null;
  base_head: string;
}

const COLS = 'id,workspace_id,ts,branches,result,detail,base_head';

function toRow(r: MergeTrialRecord): MergeTrialRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    ts: r.ts,
    branches: JSON.parse(r.branches) as string[],
    result: r.result as MergeTrialResult,
    detail: r.detail,
    baseHead: r.base_head,
  };
}

export class MergeTrialRepo {
  constructor(private readonly db: Database) {}

  insert(row: MergeTrialRow): void {
    this.db
      .prepare(`INSERT INTO merge_trial (${COLS}) VALUES (?,?,?,?,?,?,?)`)
      .run(row.id, row.workspaceId, row.ts, JSON.stringify(row.branches), row.result, row.detail, row.baseHead);
  }

  listByWorkspace(workspaceId: string): MergeTrialRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM merge_trial WHERE workspace_id=? ORDER BY ts ASC`)
        .all(workspaceId) as MergeTrialRecord[]
    ).map(toRow);
  }
}
