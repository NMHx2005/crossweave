import type { Database } from 'bun:sqlite';
import type { PersistedCheck } from '../../daemon/checks.js';

interface Record_ {
  session_id: string;
  state: 'pass' | 'fail';
  at: number;
  finished_at: number;
  ms: number;
  code: number | null;
  tail: string | null;
  changed: number | null;
  ahead: number | null;
}

/** The last finished `cw check` verdict per session (see migration 18). One row per session; replaced by the next run. */
export class SessionCheckRepo {
  constructor(private readonly db: Database) {}

  /** Every stored verdict, read once when the daemon starts. */
  load(): Map<string, PersistedCheck> {
    const rows = this.db.prepare('SELECT * FROM session_check').all() as Record_[];
    return new Map(rows.map((r) => [r.session_id, {
      state: r.state, at: r.at, finishedAt: r.finished_at, ms: r.ms,
      ...(r.code === null ? {} : { code: r.code }),
      ...(r.tail === null ? {} : { tail: r.tail }),
      changed: r.changed, ahead: r.ahead,
    }]));
  }

  save(sessionId: string, c: PersistedCheck): void {
    this.db.prepare(
      `INSERT INTO session_check (session_id, state, at, finished_at, ms, code, tail, changed, ahead)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, at = excluded.at, finished_at = excluded.finished_at,
         ms = excluded.ms, code = excluded.code, tail = excluded.tail, changed = excluded.changed, ahead = excluded.ahead`,
    ).run(sessionId, c.state, c.at, c.finishedAt, c.ms, c.code ?? null, c.tail ?? null, c.changed, c.ahead);
  }

  remove(sessionId: string): void {
    this.db.prepare('DELETE FROM session_check WHERE session_id = ?').run(sessionId);
  }
}
