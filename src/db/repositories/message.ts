import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../../core/errors.js';

export type MessageType = 'direct' | 'broadcast' | 'handoff';
export type MessageTrust = 'system' | 'user' | 'agent';

export interface MessageRow {
  id: string;
  workspaceId: string;
  fromSession: string;
  toSession: string;
  type: MessageType;
  body: string;
  contextRef: string | null;
  createdAt: string;
  deliveredAt: string | null;
  trust: MessageTrust;
}

interface MessageRecord {
  id: string;
  workspace_id: string;
  from_session: string;
  to_session: string;
  type: string;
  body: string;
  context_ref: string | null;
  created_at: string;
  delivered_at: string | null;
  trust: string;
}

const MESSAGE_BODY_MAX = 8 * 1024;
const COLS =
  'id,workspace_id,from_session,to_session,type,body,context_ref,created_at,delivered_at,trust';

function toRow(r: MessageRecord): MessageRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    fromSession: r.from_session,
    toSession: r.to_session,
    type: r.type as MessageType,
    body: r.body,
    contextRef: r.context_ref,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    trust: r.trust as MessageTrust,
  };
}

export class MessageRepo {
  constructor(private readonly db: Database) {}

  insert(row: MessageRow): void {
    if (Buffer.byteLength(row.body, 'utf8') > MESSAGE_BODY_MAX) {
      throw new CrossweaveError('MESSAGE_TOO_LARGE', `Message body exceeds ${MESSAGE_BODY_MAX} bytes`);
    }
    this.db
      .prepare(`INSERT INTO message (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        row.id, row.workspaceId, row.fromSession, row.toSession, row.type,
        row.body, row.contextRef, row.createdAt, row.deliveredAt, row.trust,
      );
  }

  findById(id: string): MessageRow | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM message WHERE id=?`).get(id) as MessageRecord | null;
    return r ? toRow(r) : undefined;
  }

  /** Undelivered messages addressed to this session, oldest first. */
  listPending(toSession: string): MessageRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM message WHERE to_session=? AND delivered_at IS NULL ORDER BY created_at ASC`)
        .all(toSession) as MessageRecord[]
    ).map(toRow);
  }

  markDelivered(id: string): void {
    this.db.prepare('UPDATE message SET delivered_at=? WHERE id=?').run(new Date().toISOString(), id);
  }

  /** Marks a whole batch delivered atomically — see `MessageBus.deliverAll`. */
  markDeliveredMany(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const statement = this.db.prepare('UPDATE message SET delivered_at=? WHERE id=?');
    this.db.transaction(() => {
      for (const id of ids) statement.run(now, id);
    })();
  }
}
