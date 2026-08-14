import type { Database } from 'bun:sqlite';

export type NotifyEventKind = 'collision' | 'blocked' | 'land' | 'convergence';

export interface NotifyConfigRow {
  workspaceId: string;
  enabled: boolean;
  collision: boolean;
  blocked: boolean;
  land: boolean;
  convergence: boolean;
}

interface NotifyConfigRecord {
  workspace_id: string;
  enabled: number;
  collision: number;
  blocked: number;
  land: number;
  convergence: number;
}

const COLUMNS = 'workspace_id, enabled, collision, blocked, land, convergence';

function toRow(r: NotifyConfigRecord): NotifyConfigRow {
  return {
    workspaceId: r.workspace_id,
    enabled: r.enabled === 1,
    collision: r.collision === 1,
    blocked: r.blocked === 1,
    land: r.land === 1,
    convergence: r.convergence === 1,
  };
}

/**
 * Mirrors ConfigTrustRepo's exact shape (src/db/repositories/config-trust.ts) — a
 * missing row means "every default is on", read live through an RPC rather than
 * cached into a CrossweaveConfig snapshot, so a toggle takes effect immediately on
 * the already-running daemon. See design doc §3.3's correction note for why this is
 * a DB table and not part of crossweave.config.json.
 */
export class NotifyConfigRepo {
  constructor(private readonly db: Database) {}

  get(workspaceId: string): NotifyConfigRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM notify_config WHERE workspace_id = ?`).get(workspaceId) as
      | NotifyConfigRecord
      | null;
    return r ? toRow(r) : undefined;
  }

  setEnabled(workspaceId: string, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO notify_config (workspace_id, enabled) VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(workspaceId, enabled ? 1 : 0);
  }

  setEvent(workspaceId: string, event: NotifyEventKind, enabled: boolean): void {
    // `event` is one of a fixed 4-member union, never client-supplied as a raw
    // string that reaches SQL — but the column name still can't be a bound
    // parameter (SQLite doesn't allow that), so it's validated against the
    // exact same union the type system already enforces before ever touching
    // string interpolation, closing the gap for a caller that bypasses the
    // type checker (e.g. a JS caller, or `as` cast).
    if (event !== 'collision' && event !== 'blocked' && event !== 'land' && event !== 'convergence') {
      throw new Error(`invalid notify event: ${String(event)}`);
    }
    this.db
      .prepare(
        `INSERT INTO notify_config (workspace_id, ${event}) VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET ${event} = excluded.${event}`,
      )
      .run(workspaceId, enabled ? 1 : 0);
  }

  isEnabled(workspaceId: string, event: NotifyEventKind): boolean {
    const row = this.get(workspaceId);
    if (row === undefined) return true; // no row yet — every default is on
    if (!row.enabled) return false; // master switch wins over any per-event column
    return row[event];
  }
}
