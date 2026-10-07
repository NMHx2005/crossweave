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
export interface SessionHistoryFilter {
  status?: SessionHistoryRow['finalStatus'];
  /** Case-insensitive substring of the session name; `%` and `_` match themselves. */
  query?: string;
}

/** Rows kept per workspace: the table is a memory aid, not an audit log, so it must not grow forever. */
export const SESSION_HISTORY_KEEP = 500;

export class SessionHistoryRepo {
  constructor(private readonly db: Database, private readonly keep = SESSION_HISTORY_KEEP) {}

  record(row: SessionHistoryRow): void {
    this.db
      .prepare(`INSERT INTO session_history (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id, row.workspaceId, row.sessionId, row.name, row.agentKind, row.branch,
        row.finalStatus, row.createdAt, row.endedAt, row.tokenSpent, row.costSpentUsd, row.note,
      );
    // Trimmed on write, in the order listByWorkspace reads, so what is dropped is exactly what no listing could reach.
    this.db
      .prepare(
        `DELETE FROM session_history WHERE workspace_id = ? AND id NOT IN (
           SELECT id FROM session_history WHERE workspace_id = ? ORDER BY ended_at DESC, id DESC LIMIT ?)`,
      )
      .run(row.workspaceId, row.workspaceId, this.keep);
  }

  listByWorkspace(workspaceId: string, limit = 50, filter: SessionHistoryFilter = {}): SessionHistoryRow[] {
    const where = ['workspace_id = ?'];
    const args: Array<string | number> = [workspaceId];
    if (filter.status !== undefined) {
      where.push('final_status = ?');
      args.push(filter.status);
    }
    if (filter.query !== undefined && filter.query !== '') {
      where.push("name LIKE ? ESCAPE '\\' COLLATE NOCASE");
      args.push(`%${filter.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM session_history WHERE ${where.join(' AND ')} ORDER BY ended_at DESC, id DESC LIMIT ?`)
      .all(...args, limit) as SessionHistoryRecord[];
    return rows.map(toRow);
  }
}
