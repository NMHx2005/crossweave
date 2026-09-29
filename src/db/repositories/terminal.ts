import type { Database } from 'bun:sqlite';

export interface TerminalRow {
  id: string;
  workspaceId: string;
  sessionId: string;
  createdAt: string;
  /** The tail of the terminal's output, saved so a restarted daemon can show it again. */
  snapshot: string | null;
  snapshotAt: string | null;
}

interface TerminalRecord {
  id: string;
  workspace_id: string;
  session_id: string;
  created_at: string;
  snapshot: string | null;
  snapshot_at: string | null;
}

const COLUMNS = 'id, workspace_id, session_id, created_at, snapshot, snapshot_at';

function toRow(r: TerminalRecord): TerminalRow {
  return { id: r.id, workspaceId: r.workspace_id, sessionId: r.session_id, createdAt: r.created_at, snapshot: r.snapshot, snapshotAt: r.snapshot_at };
}

/**
 * The terminals a daemon should reopen after a restart. Only while persistence is switched
 * on (it is off by default: a snapshot is a terminal's output at rest). A row goes when its
 * terminal is closed by the user, when its shell ends, and — by cascade — when its session
 * is deleted.
 */
export class TerminalRepo {
  constructor(private readonly db: Database) {}

  /** Idempotent by id: a restored terminal keeps its row (and its first `createdAt`). */
  insert(row: { id: string; workspaceId: string; sessionId: string; createdAt: string }): void {
    this.db
      .prepare('INSERT INTO terminal (id, workspace_id, session_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(row.id, row.workspaceId, row.sessionId, row.createdAt);
  }

  get(id: string): TerminalRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM terminal WHERE id = ?`).get(id) as TerminalRecord | null;
    return r ? toRow(r) : undefined;
  }

  listAll(): TerminalRow[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM terminal ORDER BY created_at, id`).all() as TerminalRecord[]).map(toRow);
  }

  setSnapshot(id: string, snapshot: string, at: string): void {
    this.db.prepare('UPDATE terminal SET snapshot = ?, snapshot_at = ? WHERE id = ?').run(snapshot, at, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM terminal WHERE id = ?').run(id);
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM terminal WHERE session_id = ?').run(sessionId);
  }

  deleteAll(): void {
    this.db.prepare('DELETE FROM terminal').run();
  }
}
