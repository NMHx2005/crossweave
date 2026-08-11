import type { Database } from 'bun:sqlite';

export type EventKind = 'session.started' | 'session.forked' | 'commit.made' | 'session.landed';

export interface EventRow {
  id: string;
  sessionId: string;
  workspaceId: string;
  ts: string;
  kind: EventKind;
  payload: string;
}

interface EventRecord {
  id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  kind: string;
  payload: string;
}

const COLS = 'id,session_id,workspace_id,ts,kind,payload';

function toRow(r: EventRecord): EventRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    workspaceId: r.workspace_id,
    ts: r.ts,
    kind: r.kind as EventKind,
    payload: r.payload,
  };
}

export class EventRepo {
  constructor(private readonly db: Database) {}

  insert(row: EventRow): void {
    this.db
      .prepare(`INSERT INTO event (${COLS}) VALUES (?,?,?,?,?,?)`)
      .run(row.id, row.sessionId, row.workspaceId, row.ts, row.kind, row.payload);
  }

  listBySession(sessionId: string): EventRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM event WHERE session_id=? ORDER BY ts ASC`)
        .all(sessionId) as EventRecord[]
    ).map(toRow);
  }

  listByWorkspace(workspaceId: string): EventRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM event WHERE workspace_id=? ORDER BY ts ASC`)
        .all(workspaceId) as EventRecord[]
    ).map(toRow);
  }
}
