import type { Database } from 'bun:sqlite';

export interface SessionHistoryRow {
  id: string;
  workspaceId: string;
  sessionId: string;
  name: string;
  agentKind: string;
  branch: string | null;
  finalStatus: 'landed' | 'dead';
  createdAt: string;
  endedAt: string;
  tokenSpent: number;
  costSpentUsd: number;
  note: string | null;
}

interface SessionHistoryRecord {
  id: string;
  workspace_id: string;
  session_id: string;
  name: string;
  agent_kind: string;
  branch: string | null;
  final_status: string;
  created_at: string;
  ended_at: string;
  token_spent: number;
  cost_spent_usd: number;
  note: string | null;
}

const COLUMNS =
  'id, workspace_id, session_id, name, agent_kind, branch, final_status, created_at, ended_at, token_spent, cost_spent_usd, note';

function toRow(r: SessionHistoryRecord): SessionHistoryRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    name: r.name,
    agentKind: r.agent_kind,
    branch: r.branch,
    finalStatus: r.final_status as SessionHistoryRow['finalStatus'],
    createdAt: r.created_at,
    endedAt: r.ended_at,
    tokenSpent: r.token_spent,
    costSpentUsd: r.cost_spent_usd,
    note: r.note,
  };
}

/**
 * The durable record of a session that once existed: written just before its row is
 * deleted (`session rm`, `kill --rm-worktree`, `gc`), never updated afterward. Not a
 * foreign key to `session` — the whole point is to outlive it.
 */
export class SessionHistoryRepo {
  constructor(private readonly db: Database) {}

  record(row: SessionHistoryRow): void {
    this.db
      .prepare(`INSERT INTO session_history (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id, row.workspaceId, row.sessionId, row.name, row.agentKind, row.branch,
        row.finalStatus, row.createdAt, row.endedAt, row.tokenSpent, row.costSpentUsd, row.note,
      );
  }

  listByWorkspace(workspaceId: string, limit = 50): SessionHistoryRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM session_history WHERE workspace_id = ? ORDER BY ended_at DESC, id DESC LIMIT ?`)
      .all(workspaceId, limit) as SessionHistoryRecord[];
    return rows.map(toRow);
  }
}
