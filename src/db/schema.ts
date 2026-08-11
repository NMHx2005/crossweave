export const SCHEMA_VERSION = 5;

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
  [
    `CREATE TABLE lease (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('port','db','docker','cache')),
    value       TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    released_at TEXT
  )`,
    `CREATE INDEX lease_active ON lease (kind, released_at)`,
    `CREATE INDEX lease_by_session ON lease (session_id)`,
  ],
  [
    `CREATE TABLE event (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    ts           TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('session.started', 'commit.made')),
    payload      TEXT NOT NULL
  )`,
    `CREATE INDEX event_by_session ON event (session_id, ts)`,
    `CREATE INDEX event_by_workspace_kind ON event (workspace_id, kind, ts)`,

    `CREATE TABLE message (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    from_session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    to_session   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    type         TEXT NOT NULL CHECK (type IN ('direct','broadcast','handoff')),
    body         TEXT NOT NULL,
    context_ref  TEXT,
    created_at   TEXT NOT NULL,
    delivered_at TEXT,
    trust        TEXT NOT NULL CHECK (trust IN ('system','user','agent'))
  )`,
    `CREATE INDEX message_pending ON message (to_session, delivered_at)`,

    `CREATE TABLE context_entry (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    scope        TEXT NOT NULL CHECK (scope IN ('private','shared')),
    key          TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE (workspace_id, session_id, key)
  )`,
    `CREATE INDEX context_shared ON context_entry (workspace_id, scope)`,
  ],
  [
    // Adds the `session.forked` kind, which carries the commit a session's branch was
    // created from. SQLite cannot widen a CHECK constraint in place, so the table is
    // rebuilt: nothing references `event`, so a plain copy-drop-rename is safe even
    // with `PRAGMA foreign_keys = ON`. Its indexes go with the dropped table and are
    // recreated below.
    `CREATE TABLE event_v4 (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    ts           TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('session.started', 'session.forked', 'commit.made')),
    payload      TEXT NOT NULL
  )`,
    `INSERT INTO event_v4 (id, session_id, workspace_id, ts, kind, payload)
       SELECT id, session_id, workspace_id, ts, kind, payload FROM event`,
    `DROP TABLE event`,
    `ALTER TABLE event_v4 RENAME TO event`,
    `CREATE INDEX event_by_session ON event (session_id, ts)`,
    `CREATE INDEX event_by_workspace_kind ON event (workspace_id, kind, ts)`,
  ],
  [
    // Collision Radar (M3): per-session claims on files/symbols, and the
    // contracts sessions can pin a symbol's public shape against.
    `CREATE TABLE file_claim (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    path         TEXT NOT NULL,
    symbol       TEXT,
    kind         TEXT NOT NULL CHECK (kind IN ('function','class','method','interface','type','const','file')),
    head_sha     TEXT NOT NULL,
    body_hash    TEXT NOT NULL,
    first_seen   TEXT NOT NULL,
    last_seen    TEXT NOT NULL
  )`,
    `CREATE INDEX file_claim_by_workspace_path ON file_claim (workspace_id, path)`,
    `CREATE INDEX file_claim_by_session ON file_claim (session_id)`,

    `CREATE TABLE contract (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    owner_session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    symbol_fqn    TEXT NOT NULL,
    sig_hash      TEXT NOT NULL,
    declared_at   TEXT NOT NULL,
    stable_by     TEXT,
    UNIQUE (workspace_id, symbol_fqn)
  )`,

    `CREATE TABLE contract_sub (
    contract_id   TEXT NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
    session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    subscribed_at TEXT NOT NULL,
    PRIMARY KEY (contract_id, session_id)
  )`,
  ],
];
