import type { Database } from 'bun:sqlite';

export interface ConfigTrustRow {
  workspaceId: string;
  testCommandHash: string;
  trustedAt: string;
  /** The `hooks` trust hash, when the workspace has trusted them. Absent = none. */
  hooksHash?: string;
}

interface ConfigTrustRecord {
  workspace_id: string;
  test_command_hash: string;
  trusted_at: string;
  hooks_hash: string | null;
}

function toRow(r: ConfigTrustRecord): ConfigTrustRow {
  return {
    workspaceId: r.workspace_id,
    testCommandHash: r.test_command_hash,
    trustedAt: r.trusted_at,
    // Absent (not null) when untrusted, so a row that never trusted hooks reads exactly
    // as it did before the column existed.
    ...(r.hooks_hash === null ? {} : { hooksHash: r.hooks_hash }),
  };
}

const COLUMNS = 'workspace_id, test_command_hash, trusted_at, hooks_hash';

export class ConfigTrustRepo {
  constructor(private readonly db: Database) {}

  get(workspaceId: string): ConfigTrustRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM config_trust WHERE workspace_id = ?`).get(workspaceId) as
      | ConfigTrustRecord
      | null;
    return r ? toRow(r) : undefined;
  }

  /**
   * Trust (or re-trust) the test command. Deliberately does NOT touch `hooks_hash`: the
   * hooks are a separate trust, and trusting one must never arm the other — see
   * `setHooks` and src/convergence/trust.ts.
   */
  upsert(row: ConfigTrustRow): void {
    this.db
      .prepare(
        `INSERT INTO config_trust (${COLUMNS}) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET test_command_hash = excluded.test_command_hash, trusted_at = excluded.trusted_at`,
      )
      .run(row.workspaceId, row.testCommandHash, row.trustedAt, row.hooksHash ?? null);
  }

  /**
   * Trust the hooks, leaving any test-command trust in place. A hooks-only workspace gets
   * an empty `test_command_hash` (`''`, never a real hash) so `isTestCommandTrusted` stays
   * false for it.
   */
  setHooks(workspaceId: string, hooksHash: string, trustedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO config_trust (${COLUMNS}) VALUES (?, '', ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET hooks_hash = excluded.hooks_hash, trusted_at = excluded.trusted_at`,
      )
      .run(workspaceId, trustedAt, hooksHash);
  }

  /** Clears both trusts — `cw config untrust` revokes everything for the workspace. */
  clear(workspaceId: string): void {
    this.db.prepare('DELETE FROM config_trust WHERE workspace_id = ?').run(workspaceId);
  }
}
