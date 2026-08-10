import type { Database } from 'bun:sqlite';

export type LeaseKind = 'port' | 'db' | 'docker' | 'cache';

export interface LeaseRow {
  id: string;
  sessionId: string;
  kind: LeaseKind;
  value: string;
  acquiredAt: string;
  releasedAt: string | null;
}

interface LeaseRecord {
  id: string;
  session_id: string;
  kind: string;
  value: string;
  acquired_at: string;
  released_at: string | null;
}

const COLUMNS = 'id, session_id, kind, value, acquired_at, released_at';

function toRow(r: LeaseRecord): LeaseRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind as LeaseKind,
    value: r.value,
    acquiredAt: r.acquired_at,
    releasedAt: r.released_at,
  };
}

export class LeaseRepo {
  constructor(private readonly db: Database) {}

  insert(row: LeaseRow): void {
    this.db
      .prepare(`INSERT INTO lease (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.sessionId, row.kind, row.value, row.acquiredAt, row.releasedAt);
  }

  listBySession(sessionId: string): LeaseRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM lease WHERE session_id = ? ORDER BY acquired_at ASC, id ASC`)
      .all(sessionId) as LeaseRecord[];
    return rows.map(toRow);
  }

  /** Outstanding leases of one kind — what the allocator must avoid colliding with. */
  listActive(kind: LeaseKind): LeaseRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM lease WHERE kind = ? AND released_at IS NULL`)
      .all(kind) as LeaseRecord[];
    return rows.map(toRow);
  }

  /** Idempotent: a lease already released keeps its original timestamp. */
  release(sessionId: string): void {
    this.db
      .prepare('UPDATE lease SET released_at = ? WHERE session_id = ? AND released_at IS NULL')
      .run(new Date().toISOString(), sessionId);
  }

  /** Used on daemon start: nothing this process holds can have survived its death. */
  releaseAll(): void {
    this.db
      .prepare('UPDATE lease SET released_at = ? WHERE released_at IS NULL')
      .run(new Date().toISOString());
  }
}
