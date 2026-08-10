import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../../core/errors.js';

export type ContextScope = 'private' | 'shared';

export interface ContextEntryRow {
  id: string;
  workspaceId: string;
  sessionId: string;
  scope: ContextScope;
  key: string;
  body: string;
  createdAt: string;
}

interface ContextRecord {
  id: string;
  workspace_id: string;
  session_id: string;
  scope: string;
  key: string;
  body: string;
  created_at: string;
}

const CONTEXT_BODY_MAX = 64 * 1024;
/**
 * The key is part of a UNIQUE index and is echoed back in every `cw_read_context`
 * listing, so an unbounded one is a cheap way for an agent to bloat both. Generous
 * for anything that reads like a name.
 */
const CONTEXT_KEY_MAX = 256;
const COLS = 'id,workspace_id,session_id,scope,key,body,created_at';

function toRow(r: ContextRecord): ContextEntryRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    scope: r.scope as ContextScope,
    key: r.key,
    body: r.body,
    createdAt: r.created_at,
  };
}

export class ContextRepo {
  constructor(private readonly db: Database) {}

  /**
   * Overwriting an existing (workspaceId, sessionId, key) keeps the ORIGINAL id —
   * a `contextRef` issued by an earlier publish must still resolve after a later one.
   */
  upsert(row: ContextEntryRow): void {
    if (Buffer.byteLength(row.key, 'utf8') > CONTEXT_KEY_MAX) {
      throw new CrossweaveError('CONTEXT_TOO_LARGE', `Context key exceeds ${CONTEXT_KEY_MAX} bytes`);
    }
    if (Buffer.byteLength(row.body, 'utf8') > CONTEXT_BODY_MAX) {
      throw new CrossweaveError('CONTEXT_TOO_LARGE', `Context body exceeds ${CONTEXT_BODY_MAX} bytes`);
    }
    this.db
      .prepare(
        `INSERT INTO context_entry (${COLS}) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id,session_id,key) DO UPDATE SET
           body=excluded.body, scope=excluded.scope, created_at=excluded.created_at`,
      )
      .run(row.id, row.workspaceId, row.sessionId, row.scope, row.key, row.body, row.createdAt);
  }

  findById(id: string): ContextEntryRow | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM context_entry WHERE id=?`).get(id) as ContextRecord | null;
    return r ? toRow(r) : undefined;
  }

  findByKey(workspaceId: string, sessionId: string, key: string): ContextEntryRow | undefined {
    const r = this.db
      .prepare(`SELECT ${COLS} FROM context_entry WHERE workspace_id=? AND session_id=? AND key=?`)
      .get(workspaceId, sessionId, key) as ContextRecord | null;
    return r ? toRow(r) : undefined;
  }

  listShared(workspaceId: string): ContextEntryRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM context_entry WHERE workspace_id=? AND scope='shared' ORDER BY created_at ASC`)
        .all(workspaceId) as ContextRecord[]
    ).map(toRow);
  }
}
