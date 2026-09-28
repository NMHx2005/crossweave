import type { Database } from 'bun:sqlite';

/**
 * Whether a session's `hooks.sessionSetup` has already been typed into its shell. One
 * row per session that has had it run, so a second start does not run it again. A
 * separate table rather than a session column: nothing that reads a `SessionRow` has to
 * change to add it.
 */
export class SessionSetupRepo {
  constructor(private readonly db: Database) {}

  has(sessionId: string): boolean {
    return this.db.prepare('SELECT 1 FROM session_setup WHERE session_id = ?').get(sessionId) !== null;
  }

  /** Every marked session in one query — `session.list` should not run this per row. */
  markedIds(): Set<string> {
    const rows = this.db.prepare('SELECT session_id FROM session_setup').all() as Array<{ session_id: string }>;
    return new Set(rows.map((r) => r.session_id));
  }

  /** Idempotent: marking a session that is already marked leaves the original time. */
  mark(sessionId: string): void {
    this.db
      .prepare('INSERT INTO session_setup (session_id, ran_at) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING')
      .run(sessionId, new Date().toISOString());
  }

  clear(sessionId: string): void {
    this.db.prepare('DELETE FROM session_setup WHERE session_id = ?').run(sessionId);
  }
}
