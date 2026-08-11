import type { Database } from 'bun:sqlite';

export interface ConfigTrustRow {
  workspaceId: string;
  testCommandHash: string;
  trustedAt: string;
}

interface ConfigTrustRecord {
  workspace_id: string;
  test_command_hash: string;
  trusted_at: string;
}

function toRow(r: ConfigTrustRecord): ConfigTrustRow {
  return { workspaceId: r.workspace_id, testCommandHash: r.test_command_hash, trustedAt: r.trusted_at };
}

const COLUMNS = 'workspace_id, test_command_hash, trusted_at';

export class ConfigTrustRepo {
  constructor(private readonly db: Database) {}

  get(workspaceId: string): ConfigTrustRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM config_trust WHERE workspace_id = ?`).get(workspaceId) as
      | ConfigTrustRecord
      | null;
    return r ? toRow(r) : undefined;
  }

  upsert(row: ConfigTrustRow): void {
    this.db
      .prepare(
        `INSERT INTO config_trust (${COLUMNS}) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET test_command_hash = excluded.test_command_hash, trusted_at = excluded.trusted_at`,
      )
      .run(row.workspaceId, row.testCommandHash, row.trustedAt);
  }

  clear(workspaceId: string): void {
    this.db.prepare('DELETE FROM config_trust WHERE workspace_id = ?').run(workspaceId);
  }
}
