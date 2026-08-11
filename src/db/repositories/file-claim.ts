import type { Database } from 'bun:sqlite';

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'const' | 'file';

export interface FileClaimRow {
  id: string;
  sessionId: string;
  workspaceId: string;
  path: string;
  symbol: string | null;
  kind: SymbolKind;
  headSha: string;
  bodyHash: string;
  firstSeen: string;
  lastSeen: string;
}

interface FileClaimRecord {
  id: string;
  session_id: string;
  workspace_id: string;
  path: string;
  symbol: string | null;
  kind: string;
  head_sha: string;
  body_hash: string;
  first_seen: string;
  last_seen: string;
}

const COLS =
  'id,session_id,workspace_id,path,symbol,kind,head_sha,body_hash,first_seen,last_seen';

function toRow(r: FileClaimRecord): FileClaimRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    workspaceId: r.workspace_id,
    path: r.path,
    symbol: r.symbol,
    kind: r.kind as SymbolKind,
    headSha: r.head_sha,
    bodyHash: r.body_hash,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
}

export class FileClaimRepo {
  constructor(private readonly db: Database) {}

  /**
   * `symbol IS NULL` cannot be matched with `symbol = ?` — SQL's `=` against
   * NULL is never true — so the file-level lookup (`symbol === null`) needs
   * its own branch rather than one `WHERE symbol = ?` for both cases.
   */
  findOne(sessionId: string, path: string, symbol: string | null): FileClaimRow | undefined {
    const clause = symbol === null ? 'symbol IS NULL' : 'symbol = ?';
    const args = symbol === null ? [sessionId, path] : [sessionId, path, symbol];
    const r = this.db
      .prepare(`SELECT ${COLS} FROM file_claim WHERE session_id=? AND path=? AND ${clause}`)
      .get(...args) as FileClaimRecord | null;
    return r ? toRow(r) : undefined;
  }

  /** Insert-or-replace-in-place, keyed on (sessionId, path, symbol) — see findOne for why this is not a SQL UNIQUE constraint. */
  upsert(row: FileClaimRow): void {
    const existing = this.findOne(row.sessionId, row.path, row.symbol);
    if (existing) {
      this.db
        .prepare('UPDATE file_claim SET kind=?, head_sha=?, body_hash=?, last_seen=? WHERE id=?')
        .run(row.kind, row.headSha, row.bodyHash, row.lastSeen, existing.id);
      return;
    }
    this.db
      .prepare(`INSERT INTO file_claim (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        row.id, row.sessionId, row.workspaceId, row.path, row.symbol, row.kind,
        row.headSha, row.bodyHash, row.firstSeen, row.lastSeen,
      );
  }

  deleteOne(sessionId: string, path: string, symbol: string | null): void {
    const clause = symbol === null ? 'symbol IS NULL' : 'symbol = ?';
    const args = symbol === null ? [sessionId, path] : [sessionId, path, symbol];
    this.db.prepare(`DELETE FROM file_claim WHERE session_id=? AND path=? AND ${clause}`).run(...args);
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM file_claim WHERE session_id=?').run(sessionId);
  }

  listBySession(sessionId: string): FileClaimRow[] {
    return (
      this.db.prepare(`SELECT ${COLS} FROM file_claim WHERE session_id=?`).all(sessionId) as FileClaimRecord[]
    ).map(toRow);
  }

  listByWorkspacePath(workspaceId: string, path: string): FileClaimRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM file_claim WHERE workspace_id=? AND path=?`)
        .all(workspaceId, path) as FileClaimRecord[]
    ).map(toRow);
  }
}
