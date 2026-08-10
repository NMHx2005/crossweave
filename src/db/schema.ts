export const SCHEMA_VERSION = 1;

/**
 * Each migration is a list of single statements, never one multi-statement blob.
 * Whether a given sqlite binding executes several statements from one `exec` call
 * is exactly the kind of detail that differs between drivers, so the dependency is
 * removed rather than assumed.
 */
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE schema_meta (
    version INTEGER NOT NULL
  )`,
    `CREATE TABLE workspace (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    root_path         TEXT NOT NULL UNIQUE,
    created_at        TEXT NOT NULL,
    default_isolation TEXT NOT NULL CHECK (default_isolation IN ('worktree','shared')),
    safe_mode_tier    TEXT NOT NULL CHECK (safe_mode_tier IN ('T1','T2','T3'))
  )`,
    `CREATE TABLE session (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    agent_kind       TEXT NOT NULL,
    adapter          TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('idle','running','waiting','dead','landed')),
    worktree_path    TEXT,
    branch           TEXT,
    created_at       TEXT NOT NULL,
    last_active_at   TEXT NOT NULL,
    token_budget     INTEGER,
    token_spent      INTEGER NOT NULL DEFAULT 0,
    enforcement_tier TEXT NOT NULL CHECK (enforcement_tier IN ('T1','T2','T3')),
    pid              INTEGER,
    UNIQUE (workspace_id, name)
  )`,
    `CREATE INDEX session_by_workspace ON session (workspace_id, status)`,
  ],
];
