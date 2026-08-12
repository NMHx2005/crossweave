import type { Database } from 'bun:sqlite';

export interface WorkspaceRow {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  defaultIsolation: 'worktree' | 'shared';
  safeModeTier: 'T1' | 'T2' | 'T3';
}

interface WorkspaceRecord {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  default_isolation: string;
  safe_mode_tier: string;
}

function toRow(r: WorkspaceRecord): WorkspaceRow {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    createdAt: r.created_at,
    defaultIsolation: r.default_isolation as WorkspaceRow['defaultIsolation'],
    safeModeTier: r.safe_mode_tier as WorkspaceRow['safeModeTier'],
  };
}

const COLUMNS = 'id, name, root_path, created_at, default_isolation, safe_mode_tier';

export class WorkspaceRepo {
  constructor(private readonly db: Database) {}

  insert(row: WorkspaceRow): void {
    this.db
      .prepare(`INSERT INTO workspace (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.name, row.rootPath, row.createdAt, row.defaultIsolation, row.safeModeTier);
  }

  findById(id: string): WorkspaceRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM workspace WHERE id = ?`).get(id) as
      | WorkspaceRecord
      | null;
    return r ? toRow(r) : undefined;
  }

  findByRoot(rootPath: string): WorkspaceRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM workspace WHERE root_path = ?`).get(rootPath) as
      | WorkspaceRecord
      | null;
    return r ? toRow(r) : undefined;
  }

  list(): WorkspaceRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM workspace ORDER BY created_at ASC, id ASC`)
      .all() as WorkspaceRecord[];
    return rows.map(toRow);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workspace WHERE id = ?').run(id);
  }

  updateSafeModeTier(id: string, tier: WorkspaceRow['safeModeTier']): void {
    this.db.prepare('UPDATE workspace SET safe_mode_tier = ? WHERE id = ?').run(tier, id);
  }
}
