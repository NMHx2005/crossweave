import type { Database } from 'bun:sqlite';

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'dead' | 'landed';
export type EnforcementTier = 'T1' | 'T2' | 'T3';

export interface SessionRow {
  id: string;
  workspaceId: string;
  name: string;
  agentKind: string;
  adapter: string;
  status: SessionStatus;
  worktreePath: string | null;
  branch: string | null;
  createdAt: string;
  lastActiveAt: string;
  tokenBudget: number | null;
  tokenSpent: number;
  enforcementTier: EnforcementTier;
  pid: number | null;
}

interface SessionRecord {
  id: string;
  workspace_id: string;
  name: string;
  agent_kind: string;
  adapter: string;
  status: string;
  worktree_path: string | null;
  branch: string | null;
  created_at: string;
  last_active_at: string;
  token_budget: number | null;
  token_spent: number;
  enforcement_tier: string;
  pid: number | null;
}

const COLUMNS =
  'id, workspace_id, name, agent_kind, adapter, status, worktree_path, branch, ' +
  'created_at, last_active_at, token_budget, token_spent, enforcement_tier, pid';

const LIVE_STATUSES = ['idle', 'running', 'waiting'] as const;

function toRow(r: SessionRecord): SessionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    agentKind: r.agent_kind,
    adapter: r.adapter,
    status: r.status as SessionStatus,
    worktreePath: r.worktree_path,
    branch: r.branch,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    tokenBudget: r.token_budget,
    tokenSpent: r.token_spent,
    enforcementTier: r.enforcement_tier as EnforcementTier,
    pid: r.pid,
  };
}

export class SessionRepo {
  constructor(private readonly db: Database) {}

  insert(row: SessionRow): void {
    this.db
      .prepare(`INSERT INTO session (${COLUMNS}) VALUES (${'?, '.repeat(13)}?)`)
      .run(
        row.id, row.workspaceId, row.name, row.agentKind, row.adapter, row.status,
        row.worktreePath, row.branch, row.createdAt, row.lastActiveAt,
        row.tokenBudget, row.tokenSpent, row.enforcementTier, row.pid,
      );
  }

  findById(id: string): SessionRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM session WHERE id = ?`).get(id) as
      | SessionRecord
      | null;
    return r ? toRow(r) : undefined;
  }

  findByName(workspaceId: string, name: string): SessionRow | undefined {
    const r = this.db
      .prepare(`SELECT ${COLUMNS} FROM session WHERE workspace_id = ? AND name = ?`)
      .get(workspaceId, name) as SessionRecord | null;
    return r ? toRow(r) : undefined;
  }

  listByWorkspace(workspaceId: string): SessionRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM session WHERE workspace_id = ? ORDER BY created_at ASC, id ASC`)
      .all(workspaceId) as SessionRecord[];
    return rows.map(toRow);
  }

  listLive(workspaceId: string): SessionRow[] {
    const placeholders = LIVE_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM session WHERE workspace_id = ? AND status IN (${placeholders}) ` +
          'ORDER BY created_at ASC, id ASC',
      )
      .all(workspaceId, ...LIVE_STATUSES) as SessionRecord[];
    return rows.map(toRow);
  }

  updateStatus(id: string, status: SessionStatus, pid: number | null): void {
    this.db
      .prepare('UPDATE session SET status = ?, pid = ?, last_active_at = ? WHERE id = ?')
      .run(status, pid, new Date().toISOString(), id);
  }

  rename(id: string, name: string): void {
    this.db.prepare('UPDATE session SET name = ? WHERE id = ?').run(name, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM session WHERE id = ?').run(id);
  }

  clearWorktree(id: string): void {
    this.db.prepare('UPDATE session SET worktree_path = NULL WHERE id = ?').run(id);
  }
}
