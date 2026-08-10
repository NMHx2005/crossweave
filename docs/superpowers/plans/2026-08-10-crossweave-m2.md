# crossweave M2 Implementation Plan (redo)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a working Event Ledger + `cw blame`, a Message Bus and Context Store agents can actually reach (via a hand-rolled MCP server, no SDK dependency), and daemon-boot reconciliation — so agents can communicate and the system recovers cleanly from crashes.

**Why this is a redo:** A first M2 attempt was committed directly to `main` (no worktree, no review) and a whole-branch review found it non-functional end to end: `cw blame` never found anything (nothing ever wrote the events it read), broadcast messages were written but never read by anyone, and a missing socket error listener could crash the whole daemon. That work was reset off `main`; this plan starts clean from M1's last commit and fixes the root causes, not just the symptoms — see "Corrected design" under each task that replaces the original approach.

**Architecture:** A new `event` table (append-only) backs `cw blame`. Blame works by lazily backfilling `commit.made` events from each session's branch's git history at blame-time (a git-blame commit hash is looked up against that backfilled record) — not by waiting for a `file.changed`/`tool.call` hook that doesn't exist until M3's `PreToolUse` work. A `message` + `context_entry` table pair forms the Message Bus and Context Store; broadcast fans out to every live session **at send time** (one row per recipient) so delivery uses the exact same at-least-once mechanism as a direct message, instead of a shared `to_session IS NULL` row nobody ends up querying. Both are exposed to agents via a per-session MCP server — hand-rolled JSON-RPC 2.0 framed over a short-path unix socket in `tmpdir()`, matching what `StdioServerTransport` would have spoken, with no `@modelcontextprotocol/sdk` dependency. Reconciliation runs once, at daemon boot, in `buildMethods`.

**Tech Stack:** TypeScript strict + Bun 1.3.5+, `bun:sqlite`, `simple-git` (already present), `bun test`. **No new runtime dependency** — the Global Constraint carried from M0/M1 ("only `simple-git` and `citty`") holds; MCP is hand-rolled on `node:net` + `JSON`.

## Global Constraints

These are inherited from M0/M1 unchanged, plus two M2-specific ones.

- Bun >= 1.3.5. Not Node. `bun test`, `bun:sqlite`.
- **Only two runtime dependencies are permitted: `simple-git` and `citty`.** No `@modelcontextprotocol/sdk`, no `zod`. The MCP wire protocol (JSON-RPC 2.0, newline-delimited) is hand-written on `node:net` + `JSON.parse`/`JSON.stringify`; tool-argument validation is hand-written type checks, matching the style already used in `src/core/config.ts`.
- **POSIX only (macOS, Linux).**
- TypeScript `strict: true`. No `any`, no `@ts-ignore`. Non-null assertions (`!`) FORBIDDEN in `src/`, PERMITTED in `tests/`.
- ESM only, relative imports keep `.js` specifiers.
- All timestamps are ISO 8601 UTC strings (`new Date().toISOString()`), stored as `TEXT`.
- Every path originating outside the process goes through `assertContained`.
- DB migrations: append a new migration array entry to `MIGRATIONS` in `src/db/schema.ts`, bump `SCHEMA_VERSION`. Never edit an existing migration. Current `SCHEMA_VERSION` is 2 (lease table); this plan adds migration index 2, `SCHEMA_VERSION` → 3.
- IDs: use `newId(prefix)` from `src/core/ids.ts`. Add `'ev' | 'msg' | 'ctx'` to `IdPrefix` (`'ev'` and `'msg'` are already reserved in the union from earlier milestones' comments — confirm before adding, don't duplicate).
- SQLite parameterized queries only — no string interpolation in SQL.
- Errors follow `CrossweaveError(code, message)`, `code` matches `[A-Z_]+`.
- Message trust levels: `'system' | 'user' | 'agent'`. Size caps: 8 KB per message body, 64 KB per context-entry body — reject at the repository layer with `CrossweaveError('MESSAGE_TOO_LARGE' | 'CONTEXT_TOO_LARGE', ...)`.
- **MCP server socket path — corrected design.** The original plan put it at `.crossweave/mcp-<sessionId>.sock`. AF_UNIX socket paths are capped at ~104 bytes (macOS) / ~108 bytes (Linux); `<projectRoot>/.crossweave/mcp-<sessionId>.sock` routinely exceeds that once the project lives a few directories deep (this very repo's own worktree paths already do). A path that's too long makes `listen()` fail with `ENAMETOOLONG`/`EINVAL` — and if nothing is listening for the server's `'error'` event, Node's default behaviour is to throw, which without a top-level handler kills the daemon process and every session it's running, not just the one whose socket failed to bind. This plan places the socket in `os.tmpdir()` instead (short and stable regardless of project path depth), keeps the filename itself short, and makes every socket server's `'error'` event a caught, logged, non-fatal event — see Task 6.
- **`cw_check` and `cw_declare_contract` are NOT implemented in M2.** The reset work exposed both as real, callable MCP tools that always returned a hardcoded "no problem" response — indistinguishable from a genuine "no collision" result to any agent decision logic that checks `status === 'ok'`. Returning a fake safe signal is worse than not having the tool at all: an agent could act on it and overwrite another session's in-flight work. Both are left out of the tool list entirely until M3's Collision Radar can answer them for real.

---

## File Map

### New files
- `src/db/repositories/event.ts` — `EventRepo`
- `src/db/repositories/message.ts` — `MessageRepo`
- `src/db/repositories/context.ts` — `ContextRepo`
- `src/domain/ledger.ts` — `EventLedger` (append, blame)
- `src/domain/bus.ts` — `MessageBus` (send, broadcast, handoff, inbox)
- `src/domain/context-store.ts` — `ContextStore` (publish, readPrivate, readShared)
- `src/domain/reconciliation.ts` — `reconcile(db, projectRoot)`, called once from `buildMethods`
- `src/mcp/protocol.ts` — hand-rolled JSON-RPC 2.0 framing + MCP method shapes (no SDK)
- `src/mcp/tools.ts` — the six real tool definitions + their handlers
- `src/mcp/server.ts` — `createMcpServer(sessionId, workspaceId, db, socketPath)` — ties protocol.ts + tools.ts to a `node:net` unix-socket server
- `src/cli/commands/blame.ts` — `cw blame <file>:<line>`

### Modified files
- `src/db/schema.ts` — migration index 2 (event, message, context_entry tables); `SCHEMA_VERSION` → 3
- `src/core/ids.ts` — add `'ev' | 'msg' | 'ctx'` to `IdPrefix`
- `src/daemon/methods.ts` — `blame` RPC; wire `EventLedger`, MCP server lifecycle (create on start, close-then-delete on exit, close-all on shutdown); call `reconcile()` once at boot
- `src/daemon/main.ts` — top-level `uncaughtException`/`unhandledRejection` handlers (log, don't crash)
- `src/cli/index.ts` — register the `blame` subcommand
- `tests/helpers/git-fixture.ts` — add `commitFile(repoRoot, relativePath, content, message): Promise<string>` (returns the new commit hash), used by blame tests

### Test files (new)
- `tests/db/event-repo.test.ts`
- `tests/db/message-repo.test.ts`
- `tests/db/context-repo.test.ts`
- `tests/domain/ledger.test.ts`
- `tests/domain/bus.test.ts`
- `tests/domain/context-store.test.ts`
- `tests/domain/reconciliation.test.ts`
- `tests/mcp/protocol.test.ts`
- `tests/mcp/mcp-server.test.ts` — a **real socket client** speaking the hand-rolled protocol; also the home of the cross-session end-to-end tests (message delivery and broadcast fan-out through two real MCP connections)
- `tests/cli/blame.test.ts`

---

### Task 1: Schema migration 3 + id prefixes

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/core/ids.ts`
- Test: `tests/db/open.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, the existing `MIGRATIONS` array shape (each entry a `readonly string[]` of single statements)
- Produces: tables `event`, `message`, `context_entry`; `IdPrefix` including `'ev' | 'msg' | 'ctx'`

- [ ] **Step 1: Write the failing test**

Append to `tests/db/open.test.ts`:

```ts
  it('migrates to schema version 3 with event, message and context_entry tables', () => {
    const db = openDatabase(join(dir, 'state.db'));
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain('event');
    expect(tables).toContain('message');
    expect(tables).toContain('context_entry');
    db.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/open.test.ts`
Expected: FAIL — the three tables don't exist yet.

- [ ] **Step 3: Add `'ev' | 'msg' | 'ctx'` to `IdPrefix`**

In `src/core/ids.ts`, find the `IdPrefix` union (currently `'ws' | 's' | 'lease'` as of M1, plus whatever M0 already had). Extend it — do not remove any existing member:

```ts
export type IdPrefix = 'ws' | 's' | 'lease' | 'ev' | 'msg' | 'ctx';
```

(If the file already lists other prefixes from your checkout, keep them all — only add the three new ones.)

- [ ] **Step 4: Append migration index 2 to `src/db/schema.ts`**

Bump the version:

```ts
export const SCHEMA_VERSION = 3;
```

Append a new entry to `MIGRATIONS` (do not touch entries 0 or 1):

```ts
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
```

**Follow-on divergence (added by the final whole-branch review's fix for Task 2's fork-point bug, not by this task):** `SCHEMA_VERSION` goes to 4 and a fifth migration entry is appended later in this milestone, widening `event.kind`'s `CHECK` to `IN ('session.started', 'session.forked', 'commit.made')` via a copy-drop-rename of the `event` table (`CREATE TABLE event_v4 ... ; INSERT INTO event_v4 SELECT ... FROM event; DROP TABLE event; ALTER TABLE event_v4 RENAME TO event;`, then both indexes above recreated) — SQLite cannot `ALTER` a `CHECK` constraint in place. This entry is still append-only relative to what Task 1 ships; see the sync note in Task 2's `syncCommits` section for why it was needed.

**Corrected design vs. the reset attempt:** `message.to_session` is `NOT NULL` with `ON DELETE CASCADE`, not nullable with `ON DELETE SET NULL`. There is no longer a legitimate `to_session IS NULL` row at all — broadcast fans out to real recipients at send time (Task 3), so a message always has one. This removes the whole class of bug where a deleted recipient's leftover direct message went `to_session = NULL` and became indistinguishable from — and silently surfaced by — the broadcast query. There is no `attempts` column either (it existed in the reset attempt but nothing ever read it — dropped as unused).

- [ ] **Step 5: Run the test and the whole suite**

Run: `bun test tests/db/open.test.ts && bun test && bun run typecheck`
Expected: the new test passes; the whole suite (222 tests from M1) still passes; 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/core/ids.ts tests/db/open.test.ts
git commit -m "feat(db): add event, message and context_entry tables (schema v3)"
```

---

### Task 2: EventRepo + EventLedger with real blame

**Files:**
- Create: `src/db/repositories/event.ts`
- Create: `src/domain/ledger.ts`
- Modify: `tests/helpers/git-fixture.ts` — add `commitFile`
- Test: `tests/db/event-repo.test.ts`, `tests/domain/ledger.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, `newId`, `SessionRepo` (`listByWorkspace`, `findById` — both already exist), `makeGitFixture`
- Produces:
  - `type EventKind = 'session.started' | 'commit.made'`
  - `interface EventRow { id: string; sessionId: string; workspaceId: string; ts: string; kind: EventKind; payload: string }`
  - `class EventRepo` — `insert(row)`, `listBySession(sessionId)`, `listByWorkspace(workspaceId)`
  - `interface BlameResult { sessionId: string; sessionName: string; commitHash: string }`
  - `class EventLedger` — `append(row: Omit<EventRow, 'id' | 'ts'>): void`, `blame(workspaceId, filePath, line): BlameResult | undefined`

**Corrected design vs. the reset attempt:** the original `EventKind` included `'tool.call'` and `'file.changed'`, and `blame()` read those to attribute a git commit hash (via `tool.call`) or an uncommitted range (via `file.changed`) to a session. **Nothing in the whole codebase ever wrote either kind** — there is no hook yet that observes an agent's tool calls (that arrives with M3's `PreToolUse` plumbing), so both paths always returned nothing. This task replaces that with a design that's fully self-contained today: `blame()` first backfills a `commit.made` event for every commit reachable from every session's branch that isn't already recorded (idempotent — safe to call before every blame, since it's driven off `git log`, the ground truth, not a hook), then does an ordinary `git blame` on the target line to get its commit hash and looks up which session's backfilled events include that hash. **Scope, stated plainly:** this attributes *committed* lines correctly. An uncommitted line (git blame reports the all-zeros hash) has no session to attribute yet without a hook — `blame()` returns `undefined` for it, and the CLI says so rather than guessing.

- [ ] **Step 1: Add `commitFile` to the git fixture helper**

In `tests/helpers/git-fixture.ts`, add to the `node:fs/promises` import list and add a new `node:path` import:

```ts
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
```

(`dirname` is new; `mkdir` is new; everything else in that line already exists — merge with the existing import rather than duplicating it.)

Append this function at the end of the file:

```ts
/** Writes, adds and commits a file inside `repoRoot`. Returns the new commit's hash. */
export async function commitFile(
  repoRoot: string,
  relativePath: string,
  content: string,
  message: string,
): Promise<string> {
  const fullPath = join(repoRoot, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  await $`git add ${relativePath}`.cwd(repoRoot).quiet();
  await $`git commit -q -m ${message}`.cwd(repoRoot).quiet();
  return (await $`git rev-parse HEAD`.cwd(repoRoot).quiet().text()).trim();
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/db/event-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { EventRepo, type EventRow } from '../../src/db/repositories/event.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let events: EventRepo;
let sessionId: string;
let workspaceId: string;

function makeEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: newId('ev'),
    sessionId,
    workspaceId,
    ts: '2026-08-10T00:00:00.000Z',
    kind: 'session.started',
    payload: '{}',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-event-'));
  db = openDatabase(join(dir, 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: join(dir, 'proj'),
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
  sessionId = newId('s');
  new SessionRepo(db).insert({
    id: sessionId, workspaceId, name: 'auth', agentKind: 'claude', adapter: 'claude',
    status: 'idle', worktreePath: null, branch: null,
    createdAt: '2026-08-10T00:00:00.000Z', lastActiveAt: '2026-08-10T00:00:00.000Z',
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  events = new EventRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('EventRepo', () => {
  it('round-trips an event', () => {
    const row = makeEvent();
    events.insert(row);
    expect(events.listBySession(sessionId)).toEqual([row]);
  });

  it('listByWorkspace returns events across sessions in the workspace', () => {
    events.insert(makeEvent());
    events.insert(makeEvent({ id: newId('ev'), kind: 'commit.made', payload: '{"commitHash":"abc"}' }));
    expect(events.listByWorkspace(workspaceId)).toHaveLength(2);
  });

  it('cascades when the session is deleted', () => {
    events.insert(makeEvent());
    new SessionRepo(db).delete(sessionId);
    expect(events.listBySession(sessionId)).toHaveLength(0);
  });
});
```

Create `tests/domain/ledger.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { EventLedger } from '../../src/domain/ledger.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let sessions: SessionManager;
let ledger: EventLedger;
let workspaceId: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = new WorkspaceManager(db).init(fx.root).id;
  sessions = new SessionManager(db);
  ledger = new EventLedger(db, fx.root);
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('EventLedger', () => {
  it('attributes a committed line to the session whose branch made the commit', async () => {
    const session = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    const worktreePath = session.worktreePath;
    if (worktreePath === null) throw new Error('expected a worktree');
    await commitFile(worktreePath, 'auth.ts', 'export const x = 1;\n', 'add auth.ts');

    const result = ledger.blame(workspaceId, 'auth.ts', 1);
    expect(result?.sessionId).toBe(session.id);
    expect(result?.sessionName).toBe('auth');
  }, 30_000);

  it('attributes to the correct session when two sessions have each committed', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: true });
    if (a.worktreePath === null || b.worktreePath === null) throw new Error('expected worktrees');
    await commitFile(a.worktreePath, 'a.ts', 'export const a = 1;\n', 'a commit');
    await commitFile(b.worktreePath, 'b.ts', 'export const b = 1;\n', 'b commit');

    expect(ledger.blame(workspaceId, 'a.ts', 1)?.sessionId).toBe(a.id);
    expect(ledger.blame(workspaceId, 'b.ts', 1)?.sessionId).toBe(b.id);
  }, 30_000);

  it('returns undefined for an uncommitted line, honestly, rather than guessing', async () => {
    const session = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    if (session.worktreePath === null) throw new Error('expected a worktree');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(session.worktreePath, 'scratch.ts'), 'export const y = 1;\n');

    expect(ledger.blame(workspaceId, 'scratch.ts', 1)).toBeUndefined();
  }, 30_000);

  it('returns undefined for a file that does not exist', () => {
    expect(ledger.blame(workspaceId, 'nope.ts', 1)).toBeUndefined();
  });

  it('is idempotent — calling blame twice does not duplicate commit.made events', async () => {
    const session = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    if (session.worktreePath === null) throw new Error('expected a worktree');
    await commitFile(session.worktreePath, 'auth.ts', 'export const x = 1;\n', 'add auth.ts');

    ledger.blame(workspaceId, 'auth.ts', 1);
    ledger.blame(workspaceId, 'auth.ts', 1);

    const { EventRepo } = await import('../../src/db/repositories/event.js');
    const commitEvents = new EventRepo(db).listBySession(session.id).filter((e) => e.kind === 'commit.made');
    expect(commitEvents).toHaveLength(1);
  }, 30_000);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/db/event-repo.test.ts tests/domain/ledger.test.ts`
Expected: FAIL — cannot resolve `../../src/db/repositories/event.js` / `../../src/domain/ledger.js`.

- [ ] **Step 4: Implement `src/db/repositories/event.ts`**

```ts
import type { Database } from 'bun:sqlite';

export type EventKind = 'session.started' | 'commit.made';

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
```

- [ ] **Step 5: Implement `src/domain/ledger.ts`**

```ts
import { execFileSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { EventRepo, type EventRow } from '../db/repositories/event.js';
import { SessionRepo } from '../db/repositories/session.js';

export interface BlameResult {
  sessionId: string;
  sessionName: string;
  commitHash: string;
}

/**
 * Records session lifecycle and commit events, and answers `cw blame`.
 *
 * There is no hook yet that observes an agent's individual tool calls or file
 * writes — that is M3's `PreToolUse` plumbing. What this CAN know without a hook is
 * git's own history: every commit made on a session's branch. `blame()` backfills
 * that history lazily (idempotent — safe before every call) and answers from it.
 * A line that has not been committed yet has no session to attribute it to under
 * this design; `blame()` returns `undefined` for it rather than guessing.
 *
 * A session's own worktree is the only place a fresh file exists before it's
 * landed (M4), so plain `git blame` against `projectRoot`'s checked-out state
 * cannot see it — the file was never checked out THERE. Every git call here uses
 * `<revision>:<path>` addressing (a branch name passed straight to `git blame`)
 * instead, which reads directly from git's object database and needs nothing
 * checked out anywhere.
 */
export class EventLedger {
  private readonly events: EventRepo;
  private readonly sessions: SessionRepo;

  constructor(
    private readonly db: Database,
    private readonly projectRoot: string,
  ) {
    this.events = new EventRepo(db);
    this.sessions = new SessionRepo(db);
  }

  append(row: Omit<EventRow, 'id' | 'ts'>): void {
    this.events.insert({ ...row, id: newId('ev'), ts: new Date().toISOString() });
  }

  private knownCommitHashes(sessionId: string): Set<string> {
    const hashes = new Set<string>();
    for (const ev of this.events.listBySession(sessionId)) {
      if (ev.kind !== 'commit.made') continue;
      try {
        const payload = JSON.parse(ev.payload) as { commitHash?: string };
        if (typeof payload.commitHash === 'string') hashes.add(payload.commitHash);
      } catch {
        // Malformed payload from a future format — skip, don't crash blame over it.
      }
    }
    return hashes;
  }

  /**
   * The branch currently checked out in `projectRoot` — every session's branch was
   * created from wherever this pointed at session-creation time, so it's the
   * boundary between "shared, pre-existing history" and "this session's own work".
   * `undefined` on a detached HEAD (no usable base) or if git fails outright.
   */
  private baseBranch(): string | undefined {
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return branch === 'HEAD' ? undefined : branch;
    } catch {
      return undefined;
    }
  }

  /**
   * For every session with a branch, record any commit that's on that branch but
   * NOT on the base branch — i.e. commits the session itself made, not history it
   * inherited at fork time (which would otherwise get attributed to every session
   * that happens to share that ancestry). Safe to call repeatedly:
   * `knownCommitHashes` makes it a no-op for history it's already recorded.
   */
  private syncCommits(workspaceId: string): void {
    const base = this.baseBranch();
    if (base === undefined) return;

    for (const session of this.sessions.listByWorkspace(workspaceId)) {
      if (session.branch === null || session.branch === base) continue;

      let hashes: string[];
      try {
        const out = execFileSync('git', ['log', `${base}..${session.branch}`, '--format=%H'], {
          cwd: this.projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        hashes = out.split('\n').map((h) => h.trim()).filter(Boolean);
      } catch {
        // Branch may not exist any more (session fully removed) — nothing to sync.
        continue;
      }

      const known = this.knownCommitHashes(session.id);
      for (const hash of hashes) {
        if (known.has(hash)) continue;
        this.append({
          sessionId: session.id,
          workspaceId,
          kind: 'commit.made',
          payload: JSON.stringify({ commitHash: hash }),
        });
        known.add(hash);
      }
    }
  }
  ```

  **Plan/source divergence, found by the final whole-branch review, headline bug:** `baseBranch()` above is a LIVE `git rev-parse --abbrev-ref HEAD` in `projectRoot`, re-evaluated every time `syncCommits`/`blame()` runs — but a session's branch was only ever forked from wherever `HEAD` happened to point at the moment the session was CREATED, which is not the same thing as wherever `HEAD` points NOW. A user who checks out a different (or older) branch in their own main checkout — an entirely ordinary thing to do while agents work in worktrees — widens `${base}..${branch}` to include commits the session never made. Because the event table is append-only and deduplicated by hash, **that misattribution is written once and can never be corrected**, even after switching back to the right branch. Reproduced: create a session off `main`, have it commit, `git checkout old-release` in `projectRoot`, blame a human-authored file that's on `main` but not `old-release` — it gets attributed to the session.

  The fix captures each session's fork point ONCE, immutably, at the moment its worktree is actually created — `createWorktree` (`src/isolation/worktree.ts`) already reads `git rev-parse --verify HEAD` before calling `git worktree add -b <branch> <path> <forkPoint>`, passing that exact hash as the explicit start point (not just reading HEAD and hoping nothing raced it — the hash IS what the branch is created from). `SessionManager.create` records it as a new `session.forked` event immediately after the session row inserts: `{ kind: 'session.forked', payload: JSON.stringify({ forkPoint }) }`. This needs a fourth `EventKind` member and a schema migration, since SQLite cannot widen a `CHECK` constraint in place — migration 3 (`event.kind IN ('session.started', 'commit.made')`) becomes migration 4's `event.kind IN ('session.started', 'session.forked', 'commit.made')` via a copy-drop-rename of the `event` table (nothing references it, so this is safe even under `PRAGMA foreign_keys = ON`); `SCHEMA_VERSION` becomes 4.

  `syncCommits` and `blame()` are both rewritten to read a session's stored fork point instead of computing a live base:

  ```ts
  /**
   * One pass over a session's events for both things blame needs from them: the
   * immutable fork point recorded at session creation, and every commit already
   * attributed to it.
   */
  private history(sessionId: string): { forkPoint: string | undefined; commitHashes: Set<string> } {
    let forkPoint: string | undefined;
    const commitHashes = new Set<string>();
    for (const ev of this.events.listBySession(sessionId)) {
      if (ev.kind !== 'commit.made' && ev.kind !== 'session.forked') continue;
      try {
        const payload = JSON.parse(ev.payload) as { commitHash?: string; forkPoint?: string };
        if (ev.kind === 'commit.made') {
          if (typeof payload.commitHash === 'string') commitHashes.add(payload.commitHash);
        } else if (typeof payload.forkPoint === 'string' && payload.forkPoint.length > 0) {
          forkPoint = payload.forkPoint;
        }
      } catch {
        // Malformed payload from a future format — skip, don't crash blame over it.
      }
    }
    return { forkPoint, commitHashes };
  }

  /**
   * The branch currently checked out in `projectRoot`. Used ONLY as one more revision
   * to try `git blame` against — never to decide which commits belong to a session,
   * which is what the recorded fork point is for.
   */
  private baseBranch(): string | undefined {
    // — unchanged from above —
  }

  /**
   * For every session with a branch, record any commit on that branch that is not
   * reachable from its FORK POINT — an immutable hash captured at worktree-creation
   * time, deliberately NOT derived from whatever's checked out in `projectRoot` now.
   * A session with no recorded fork point (created before this was tracked) is
   * skipped rather than guessed at — no attribution beats a wrong, permanent one.
   */
  private syncCommits(workspaceId: string): void {
    for (const session of this.sessions.listByWorkspace(workspaceId)) {
      if (session.branch === null) continue;
      const { forkPoint, commitHashes: known } = this.history(session.id);
      if (forkPoint === undefined) continue;

      let hashes: string[];
      try {
        const out = execFileSync('git', ['log', `${forkPoint}..${session.branch}`, '--format=%H'], {
          cwd: this.projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        hashes = out.split('\n').map((h) => h.trim()).filter(Boolean);
      } catch {
        continue;
      }

      for (const hash of hashes) {
        if (known.has(hash)) continue;
        this.append({ sessionId: session.id, workspaceId, kind: 'commit.made', payload: JSON.stringify({ commitHash: hash }) });
        known.add(hash);
      }
    }
  }

  /** Blames `filePath` at `line` as it exists on `revision` — no checkout needed. */
  private blameAt(revision: string, filePath: string, line: number): string | undefined {
    try {
      const out = execFileSync(
        'git',
        ['blame', revision, `-L${line},${line}`, '--porcelain', '--', filePath],
        { cwd: this.projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const firstLine = out.split('\n')[0] ?? '';
      const hash = firstLine.slice(0, 40).trim();
      // All-zeros hash means the line is uncommitted on this revision.
      return !hash || /^0+$/.test(hash) ? undefined : hash;
    } catch {
      // Path doesn't exist on this revision at all — not an error, just not here.
      return undefined;
    }
  }

  blame(workspaceId: string, filePath: string, line: number): BlameResult | undefined {
    this.syncCommits(workspaceId);

    const base = this.baseBranch();
    const sessions = this.sessions.listByWorkspace(workspaceId);
    const revisions = [
      ...(base !== undefined ? [base] : []),
      ...sessions.map((s) => s.branch).filter((b): b is string => b !== null),
    ];

    for (const revision of revisions) {
      const commitHash = this.blameAt(revision, filePath, line);
      if (commitHash === undefined) continue; // not found on this revision — try the next
      for (const session of sessions) {
        if (this.knownCommitHashes(session.id).has(commitHash)) {
          return { sessionId: session.id, sessionName: session.name, commitHash };
        }
      }
      return undefined; // a real commit, found — but not made by any tracked session
    }
    return undefined; // not found on any known revision, or genuinely uncommitted everywhere
  }
}
```

**Two small follow-on divergences from the same fix (final whole-branch review, Minor):**

1. `blameAt`'s all-zeros-hash comment above was already known-inert (synced during Task 2's own fix round); the final review's fix-wave rewrote it once more, purely for wording, to explicitly say the catch below is what actually makes an uncommitted line return `undefined` — no behavior change.
2. `blame()` above calls `this.knownCommitHashes(session.id)` inside the revision loop, i.e. once per `(revision, session)` pair — the event table is re-queried and re-JSON-parsed that many times per call. Harmless at this milestone's scale but easy to avoid: `history(sessionId)` (the helper the fork-point fix introduced) already returns `commitHashes` alongside `forkPoint`, so `blame()` now builds one `Map<hash, {id, name}>` up front — after `syncCommits` has finished writing, since that's what makes the map complete — and looks up each revision's hash in that map instead of re-querying per session:

```ts
  blame(workspaceId: string, filePath: string, line: number): BlameResult | undefined {
    this.syncCommits(workspaceId);

    const base = this.baseBranch();
    const sessions = this.sessions.listByWorkspace(workspaceId);
    const revisions = [
      ...(base !== undefined ? [base] : []),
      ...sessions.map((s) => s.branch).filter((b): b is string => b !== null),
    ];

    const bySessionOf = new Map<string, { id: string; name: string }>();
    for (const session of sessions) {
      for (const hash of this.history(session.id).commitHashes) {
        if (!bySessionOf.has(hash)) bySessionOf.set(hash, { id: session.id, name: session.name });
      }
    }

    for (const revision of revisions) {
      const commitHash = this.blameAt(revision, filePath, line);
      if (commitHash === undefined) continue;
      const owner = bySessionOf.get(commitHash);
      if (owner !== undefined) return { sessionId: owner.id, sessionName: owner.name, commitHash };
    }
    return undefined;
  }
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test tests/db/event-repo.test.ts tests/domain/ledger.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add src/db/repositories/event.ts src/domain/ledger.ts tests/helpers/git-fixture.ts tests/db/event-repo.test.ts tests/domain/ledger.test.ts
git commit -m "feat(ledger): EventRepo + EventLedger with git-backed blame"
```

---

### Task 3: MessageRepo + MessageBus, with real delivery

**Files:**
- Create: `src/db/repositories/message.ts`
- Create: `src/domain/bus.ts`
- Test: `tests/db/message-repo.test.ts`, `tests/domain/bus.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, `newId`, `CrossweaveError`, `SessionRepo` (`listLive`, `resolve`-style lookup — `SessionManager.resolve` already exists and is what this task must reuse for name-or-id resolution)
- Produces:
  - `type MessageType = 'direct' | 'broadcast' | 'handoff'`
  - `type MessageTrust = 'system' | 'user' | 'agent'`
  - `interface MessageRow { id; workspaceId; fromSession; toSession: string; type; body; contextRef: string | null; createdAt; deliveredAt: string | null; trust }`
  - `class MessageRepo` — `insert(row)`, `findById(id)`, `listPending(sessionId)`, `markDelivered(id)`
  - `class MessageBus` — `send(opts): MessageRow[]`, `broadcast(opts): MessageRow[]`, `handoff(opts): MessageRow[]`, `inbox(workspaceId, sessionId): MessageRow[]`, `deliver(messageId): void`

**Corrected design vs. the reset attempt:**
1. **Broadcast fans out at send time, one row per currently-live recipient**, instead of one row with `to_session = NULL` that nothing ever read. `inbox()` becomes a single, unconditional query — `to_session = sessionId AND delivered_at IS NULL` — with no special-casing for message type. There is no more `listBroadcasts()`; there is nothing left for it to do that `inbox()` doesn't already cover. This is why `send`/`broadcast`/`handoff` now return `MessageRow[]` (one row per recipient) instead of a single row — broadcast has more than one.
2. **`toSession` is resolved from name-or-id before the row is ever built**, using the exact same `resolve()` a `cw session kill <name>` already goes through — so a tool call like `cw_send({ toSession: "backend-agent", ... })` using the friendly name its own description invites actually reaches that session, instead of storing the literal string `"backend-agent"` in a column that delivery never matches against.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/message-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { MessageRepo, type MessageRow } from '../../src/db/repositories/message.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let messages: MessageRepo;
let workspaceId: string;
let fromId: string;
let toId: string;

function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: newId('msg'),
    workspaceId,
    fromSession: fromId,
    toSession: toId,
    type: 'direct',
    body: 'hello',
    contextRef: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    deliveredAt: null,
    trust: 'agent',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-message-'));
  db = openDatabase(join(dir, 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: join(dir, 'proj'),
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
  const sessions = new SessionRepo(db);
  fromId = newId('s');
  sessions.insert({
    id: fromId, workspaceId, name: 'a', agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: null, branch: null, createdAt: '2026-08-10T00:00:00.000Z',
    lastActiveAt: '2026-08-10T00:00:00.000Z', tokenBudget: null, tokenSpent: 0,
    enforcementTier: 'T3', pid: null,
  });
  toId = newId('s');
  sessions.insert({
    id: toId, workspaceId, name: 'b', agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: null, branch: null, createdAt: '2026-08-10T00:00:00.000Z',
    lastActiveAt: '2026-08-10T00:00:00.000Z', tokenBudget: null, tokenSpent: 0,
    enforcementTier: 'T3', pid: null,
  });
  messages = new MessageRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('MessageRepo', () => {
  it('round-trips a message', () => {
    const row = makeMessage();
    messages.insert(row);
    expect(messages.findById(row.id)).toEqual(row);
  });

  it('rejects a body over 8KB', () => {
    expect(() => messages.insert(makeMessage({ body: 'x'.repeat(8193) }))).toThrowError(
      expect.objectContaining({ code: 'MESSAGE_TOO_LARGE' }) as unknown as Error,
    );
  });

  it('listPending returns only undelivered messages for that recipient', () => {
    messages.insert(makeMessage());
    messages.insert(makeMessage({ id: newId('msg'), toSession: fromId }));
    const delivered = makeMessage({ id: newId('msg') });
    messages.insert(delivered);
    messages.markDelivered(delivered.id);

    expect(messages.listPending(toId)).toHaveLength(0); // the first one and the delivered one — 1 undelivered left below
  });

  it('markDelivered stamps deliveredAt', () => {
    const row = makeMessage();
    messages.insert(row);
    messages.markDelivered(row.id);
    expect(messages.findById(row.id)?.deliveredAt).not.toBeNull();
  });

  it('cascades when the recipient session is deleted', () => {
    const row = makeMessage();
    messages.insert(row);
    new SessionRepo(db).delete(toId);
    expect(messages.findById(row.id)).toBeUndefined();
  });
});
```

Fix the intentionally-wrong assertion above before running — `listPending(toId)` should be `toHaveLength(1)` (the first `makeMessage()` targets `toId` and is undelivered; the second targets `fromId`; the third targets `toId` but is delivered). Change it to:

```ts
  it('listPending returns only undelivered messages for that recipient', () => {
    messages.insert(makeMessage());
    messages.insert(makeMessage({ id: newId('msg'), toSession: fromId }));
    const delivered = makeMessage({ id: newId('msg') });
    messages.insert(delivered);
    messages.markDelivered(delivered.id);

    expect(messages.listPending(toId)).toHaveLength(1);
  });
```

Create `tests/domain/bus.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { MessageBus } from '../../src/domain/bus.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let sessions: SessionManager;
let bus: MessageBus;
let workspaceId: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = new WorkspaceManager(db).init(fx.root).id;
  sessions = new SessionManager(db);
  bus = new MessageBus(db, sessions);
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('MessageBus', () => {
  it('send resolves toSession by name and delivers to that session\'s inbox', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });

    bus.send({ workspaceId, fromSession: a.id, toSession: 'b', body: 'hi', trust: 'agent' });

    const inbox = bus.inbox(workspaceId, b.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toBe('hi');
    expect(inbox[0]?.fromSession).toBe(a.id);
  }, 30_000);

  it('send throws SESSION_NOT_FOUND for an unknown name', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    expect(() =>
      bus.send({ workspaceId, fromSession: a.id, toSession: 'ghost', body: 'hi', trust: 'agent' }),
    ).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }) as unknown as Error);
  }, 30_000);

  it('broadcast reaches every other live session, not the sender', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    const c = await sessions.create({ workspaceId, name: 'c', agent: 'claude', worktree: false });

    bus.broadcast({ workspaceId, fromSession: a.id, body: 'build is red', trust: 'agent' });

    expect(bus.inbox(workspaceId, b.id)).toHaveLength(1);
    expect(bus.inbox(workspaceId, c.id)).toHaveLength(1);
    expect(bus.inbox(workspaceId, a.id)).toHaveLength(0); // sender doesn't receive its own broadcast
  }, 30_000);

  it('broadcast does not reach a dead session', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    await sessions.kill(workspaceId, 'b', { removeWorktree: false });

    bus.broadcast({ workspaceId, fromSession: a.id, body: 'hi', trust: 'agent' });

    expect(bus.inbox(workspaceId, b.id)).toHaveLength(0);
  }, 30_000);

  it('handoff carries a contextRef through to the inbox', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });

    bus.handoff({
      workspaceId, fromSession: a.id, toSession: 'b', body: 'take over', trust: 'agent',
      contextRef: 'ctx_abc',
    });

    expect(bus.inbox(workspaceId, b.id)[0]?.contextRef).toBe('ctx_abc');
  }, 30_000);

  it('deliver marks a message delivered, removing it from the inbox', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    bus.send({ workspaceId, fromSession: a.id, toSession: 'b', body: 'hi', trust: 'agent' });

    const [msg] = bus.inbox(workspaceId, b.id);
    if (msg === undefined) throw new Error('expected a message');
    bus.deliver(msg.id);

    expect(bus.inbox(workspaceId, b.id)).toHaveLength(0);
  }, 30_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db/message-repo.test.ts tests/domain/bus.test.ts`
Expected: FAIL — cannot resolve the new modules.

- [ ] **Step 3: Implement `src/db/repositories/message.ts`**

```ts
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
}
```

- [ ] **Step 4: Implement `src/domain/bus.ts`**

```ts
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { MessageRepo, type MessageTrust, type MessageRow } from '../db/repositories/message.js';
import type { SessionManager } from './session.js';

/**
 * Delivers messages between sessions. `broadcast` fans out at send time to every
 * OTHER live session in the workspace — one row per recipient, each delivered
 * through the exact same mechanism as a direct message. There is no shared
 * "unaddressed" row for readers to miss: a session that starts after a broadcast
 * was sent simply wasn't a recipient of it, the same way it wouldn't have been in
 * the room for a message spoken before it arrived.
 */
export class MessageBus {
  private readonly repo: MessageRepo;

  constructor(
    db: Database,
    private readonly sessions: SessionManager,
  ) {
    this.repo = new MessageRepo(db);
  }

  private insertOne(opts: {
    workspaceId: string;
    fromSession: string;
    toSessionIdOrName: string;
    type: 'direct' | 'handoff';
    body: string;
    trust: MessageTrust;
    contextRef?: string;
  }): MessageRow {
    // Resolves by name OR id, exactly like `cw session kill <name>` does — so a tool
    // call using the friendly name its own description invites actually delivers.
    const recipient = this.sessions.resolve(opts.workspaceId, opts.toSessionIdOrName);
    const row: MessageRow = {
      id: newId('msg'),
      workspaceId: opts.workspaceId,
      fromSession: opts.fromSession,
      toSession: recipient.id,
      type: opts.type,
      body: opts.body,
      contextRef: opts.contextRef ?? null,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      trust: opts.trust,
    };
    this.repo.insert(row);
    return row;
  }

  send(opts: {
    workspaceId: string;
    fromSession: string;
    toSession: string;
    body: string;
    trust: MessageTrust;
    contextRef?: string;
  }): MessageRow {
    return this.insertOne({ ...opts, toSessionIdOrName: opts.toSession, type: 'direct' });
  }

  handoff(opts: {
    workspaceId: string;
    fromSession: string;
    toSession: string;
    body: string;
    trust: MessageTrust;
    contextRef?: string;
  }): MessageRow {
    return this.insertOne({ ...opts, toSessionIdOrName: opts.toSession, type: 'handoff' });
  }

  broadcast(opts: {
    workspaceId: string;
    fromSession: string;
    body: string;
    trust: MessageTrust;
  }): MessageRow[] {
    const recipients = this.sessions
      .list(opts.workspaceId)
      .filter((s) => s.id !== opts.fromSession && (s.status === 'idle' || s.status === 'running' || s.status === 'waiting'));

    return recipients.map((recipient) => {
      const row: MessageRow = {
        id: newId('msg'),
        workspaceId: opts.workspaceId,
        fromSession: opts.fromSession,
        toSession: recipient.id,
        type: 'broadcast',
        body: opts.body,
        contextRef: null,
        createdAt: new Date().toISOString(),
        deliveredAt: null,
        trust: opts.trust,
      };
      this.repo.insert(row);
      return row;
    });
  }

  /** Every undelivered message addressed to this session — direct, handoff or broadcast alike. */
  inbox(_workspaceId: string, sessionId: string): MessageRow[] {
    return this.repo.listPending(sessionId);
  }

  deliver(messageId: string): void {
    this.repo.markDelivered(messageId);
  }

  /** Marks a whole batch delivered atomically — what `cw_inbox` actually calls; see the note below. */
  deliverAll(messageIds: string[]): void {
    this.repo.markDeliveredMany(messageIds);
  }
}
```

**Plan/source divergence, found by the final whole-branch review, headline bug:** `deliver()` above is specified here but Task 7's tool set never calls it — `cw_inbox` reads `inbox()` and returns the result without ever acking it. Each half is individually correct; neither task's own review could see the gap. The result: `cw_inbox` re-surfaces every message a session has ever received on every single poll, forever — a `cw_handoff` ("take over this work") would be re-executed on every call, and the `message` table grows unbounded. This is the exact structural sibling of the reset M2 attempt's rejected defect ("broadcast messages were written but never read") — a delivery mechanism built and never wired, this time for the inbox-read path instead of the broadcast-write path.

Fix: `cw_inbox`'s MCP tool handler (Task 7) must ack every row it returns, atomically, BEFORE building its response (at-most-once: a crash between ack and the client actually receiving the reply loses the message rather than risking it being processed twice). Add `deliverAll(messageIds: string[])` to `MessageRepo`/`MessageBus` (a single SQL transaction over the batch, not one `UPDATE` per id) and call it from `cw_inbox`'s handler on exactly the ids it's about to return:

```ts
// src/mcp/tools.ts, cw_inbox's handler
const messages = bus.inbox(workspaceId, sessionId);
bus.deliverAll(messages.map((m) => m.id));
return text(messages.map((m) => ({ /* ... */ })));
```

The singular `deliver()`/`markDelivered()` above are now dead in production — nothing but their own unit tests calls them, since `deliverAll`/`markDeliveredMany` is the real path. Left in place per this project's dead-code convention (mention, don't delete opportunistically) rather than removed as a drive-by cleanup inside the fix that found them.

**Note:** `SessionManager.list(workspaceId): SessionRow[]` and `SessionManager.resolve(workspaceId, idOrName): SessionRow` are both confirmed-existing methods from M0/M1 (`src/domain/session.ts`) — this task consumes them, it does not redefine them.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/db/message-repo.test.ts tests/domain/bus.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/message.ts src/domain/bus.ts tests/db/message-repo.test.ts tests/domain/bus.test.ts
git commit -m "feat(bus): MessageRepo + MessageBus with send-time broadcast fan-out and name resolution"
```

---

### Task 4: ContextRepo + ContextStore, with a stable id

**Files:**
- Create: `src/db/repositories/context.ts`
- Create: `src/domain/context-store.ts`
- Test: `tests/db/context-repo.test.ts`, `tests/domain/context-store.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, `newId`, `CrossweaveError`
- Produces:
  - `type ContextScope = 'private' | 'shared'`
  - `interface ContextEntryRow { id; workspaceId; sessionId; scope; key; body; createdAt }`
  - `class ContextRepo` — `upsert(row)`, `findByKey(workspaceId, sessionId, key)`, `findById(id)`, `listShared(workspaceId)`
  - `class ContextStore` — `publish(workspaceId, sessionId, key, body): ContextEntryRow`, `readShared(workspaceId): ContextEntryRow[]`, `readById(id): ContextEntryRow | undefined`

**Corrected design vs. the reset attempt:** the original `upsert` used `ON CONFLICT ... DO UPDATE SET id=excluded.id` — republishing the same key issued a fresh id and silently invalidated any `contextRef` a handoff had already pointed at it. This task's `upsert` keeps the existing row's id across an overwrite (no `id=excluded.id` in the `SET` clause), and adds `findById`, which the reset attempt never had at all — nothing could resolve a `contextRef` back to a body no matter what id it held.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/context-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { ContextRepo, type ContextEntryRow } from '../../src/db/repositories/context.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let repo: ContextRepo;
let workspaceId: string;
let sessionId: string;

function makeEntry(overrides: Partial<ContextEntryRow> = {}): ContextEntryRow {
  return {
    id: newId('ctx'), workspaceId, sessionId, scope: 'shared', key: 'plan',
    body: 'do the thing', createdAt: '2026-08-10T00:00:00.000Z', ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-context-'));
  db = openDatabase(join(dir, 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: join(dir, 'proj'),
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
  sessionId = newId('s');
  new SessionRepo(db).insert({
    id: sessionId, workspaceId, name: 'a', agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: null, branch: null, createdAt: '2026-08-10T00:00:00.000Z',
    lastActiveAt: '2026-08-10T00:00:00.000Z', tokenBudget: null, tokenSpent: 0,
    enforcementTier: 'T3', pid: null,
  });
  repo = new ContextRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('ContextRepo', () => {
  it('round-trips an entry, findable by id and by key', () => {
    const row = makeEntry();
    repo.upsert(row);
    expect(repo.findById(row.id)).toEqual(row);
    expect(repo.findByKey(workspaceId, sessionId, 'plan')).toEqual(row);
  });

  it('overwriting the same key keeps the original id', () => {
    const first = makeEntry();
    repo.upsert(first);
    const second = makeEntry({ id: newId('ctx'), body: 'updated plan' });
    repo.upsert(second);

    const found = repo.findByKey(workspaceId, sessionId, 'plan');
    expect(found?.id).toBe(first.id); // NOT second.id
    expect(found?.body).toBe('updated plan');
    expect(repo.findById(first.id)?.body).toBe('updated plan');
  });

  it('rejects a body over 64KB', () => {
    expect(() => repo.upsert(makeEntry({ body: 'x'.repeat(65537) }))).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_TOO_LARGE' }) as unknown as Error,
    );
  });

  it('listShared returns only shared-scope entries', () => {
    repo.upsert(makeEntry({ key: 'shared-one', scope: 'shared' }));
    repo.upsert(makeEntry({ id: newId('ctx'), key: 'private-one', scope: 'private' }));
    const shared = repo.listShared(workspaceId);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.key).toBe('shared-one');
  });
});
```

Create `tests/domain/context-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { ContextStore } from '../../src/domain/context-store.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let store: ContextStore;
let workspaceId: string;
let sessionId: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-context-store-'));
  db = openDatabase(join(dir, 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: join(dir, 'proj'),
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
  sessionId = newId('s');
  new SessionRepo(db).insert({
    id: sessionId, workspaceId, name: 'a', agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: null, branch: null, createdAt: '2026-08-10T00:00:00.000Z',
    lastActiveAt: '2026-08-10T00:00:00.000Z', tokenBudget: null, tokenSpent: 0,
    enforcementTier: 'T3', pid: null,
  });
  store = new ContextStore(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('ContextStore', () => {
  it('publish makes an entry visible via readShared', () => {
    const entry = store.publish(workspaceId, sessionId, 'plan', 'the plan');
    expect(store.readShared(workspaceId)).toContainEqual(entry);
  });

  it('readById resolves a contextRef issued by publish', () => {
    const entry = store.publish(workspaceId, sessionId, 'plan', 'the plan');
    expect(store.readById(entry.id)?.body).toBe('the plan');
  });

  it('readById returns undefined for an unknown id', () => {
    expect(store.readById('ctx_nope')).toBeUndefined();
  });

  it('republishing the same key keeps the contextRef valid', () => {
    const first = store.publish(workspaceId, sessionId, 'plan', 'v1');
    store.publish(workspaceId, sessionId, 'plan', 'v2');
    expect(store.readById(first.id)?.body).toBe('v2');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db/context-repo.test.ts tests/domain/context-store.test.ts`
Expected: FAIL — cannot resolve the new modules.

- [ ] **Step 3: Implement `src/db/repositories/context.ts`**

```ts
import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../../core/errors.js';

export type ContextScope = 'private' | 'shared';

export interface ContextEntryRow {
  id: string;
  workspaceId: string;
  sessionId: string;
  scope: ContextScope;
  key: string;
  body: string;
  createdAt: string;
}

interface ContextRecord {
  id: string;
  workspace_id: string;
  session_id: string;
  scope: string;
  key: string;
  body: string;
  created_at: string;
}

const CONTEXT_BODY_MAX = 64 * 1024;
const COLS = 'id,workspace_id,session_id,scope,key,body,created_at';

function toRow(r: ContextRecord): ContextEntryRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    scope: r.scope as ContextScope,
    key: r.key,
    body: r.body,
    createdAt: r.created_at,
  };
}

export class ContextRepo {
  constructor(private readonly db: Database) {}

  /**
   * Overwriting an existing (workspaceId, sessionId, key) keeps the ORIGINAL id —
   * a `contextRef` issued by an earlier publish must still resolve after a later one.
   */
  upsert(row: ContextEntryRow): void {
    if (Buffer.byteLength(row.body, 'utf8') > CONTEXT_BODY_MAX) {
      throw new CrossweaveError('CONTEXT_TOO_LARGE', `Context body exceeds ${CONTEXT_BODY_MAX} bytes`);
    }
    this.db
      .prepare(
        `INSERT INTO context_entry (${COLS}) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id,session_id,key) DO UPDATE SET
           body=excluded.body, scope=excluded.scope, created_at=excluded.created_at`,
      )
      .run(row.id, row.workspaceId, row.sessionId, row.scope, row.key, row.body, row.createdAt);
  }

  findById(id: string): ContextEntryRow | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM context_entry WHERE id=?`).get(id) as ContextRecord | null;
    return r ? toRow(r) : undefined;
  }

  findByKey(workspaceId: string, sessionId: string, key: string): ContextEntryRow | undefined {
    const r = this.db
      .prepare(`SELECT ${COLS} FROM context_entry WHERE workspace_id=? AND session_id=? AND key=?`)
      .get(workspaceId, sessionId, key) as ContextRecord | null;
    return r ? toRow(r) : undefined;
  }

  listShared(workspaceId: string): ContextEntryRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM context_entry WHERE workspace_id=? AND scope='shared' ORDER BY created_at ASC`)
        .all(workspaceId) as ContextRecord[]
    ).map(toRow);
  }
}
```

- [ ] **Step 4: Implement `src/domain/context-store.ts`**

```ts
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { ContextRepo, type ContextEntryRow } from '../db/repositories/context.js';

export class ContextStore {
  private readonly repo: ContextRepo;

  constructor(db: Database) {
    this.repo = new ContextRepo(db);
  }

  /**
   * Publish (or republish) a shared context entry. Republishing the same key keeps
   * its id stable, so a `contextRef` handed to another session in an earlier handoff
   * still resolves to the latest body.
   */
  publish(workspaceId: string, sessionId: string, key: string, body: string): ContextEntryRow {
    const existing = this.repo.findByKey(workspaceId, sessionId, key);
    const row: ContextEntryRow = {
      id: existing?.id ?? newId('ctx'),
      workspaceId,
      sessionId,
      scope: 'shared',
      key,
      body,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.repo.upsert(row);
    return row;
  }

  readShared(workspaceId: string): ContextEntryRow[] {
    return this.repo.listShared(workspaceId);
  }

  readById(id: string): ContextEntryRow | undefined {
    return this.repo.findById(id);
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/db/context-repo.test.ts tests/domain/context-store.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/context.ts src/domain/context-store.ts tests/db/context-repo.test.ts tests/domain/context-store.test.ts
git commit -m "feat(context): ContextRepo + ContextStore with a stable contextRef"
```

---

### Task 5: Reconciliation

**Files:**
- Create: `src/domain/reconciliation.ts`
- Test: `tests/domain/reconciliation.test.ts`

**Interfaces:**
- Consumes: `SessionRepo` (`listLive`, `updateStatus`), `LeaseRepo` (`release`)
- Produces: `reconcile(db: Database, projectRoot: string): void`

**Corrected design vs. the reset attempt:** the original signature took a `runningPids: Map<string, number>` parameter and skipped any session already "known to this daemon" — but the only call site is once, at daemon boot, before this daemon instance has started anything, so that map is always empty and the skip could never fire. The docstring claimed it would be "populated when reconcile is called after a hot restart", but nothing ever called it that way. This task drops the unused parameter and the dead skip path — `reconcile` now just does what M1's own known-limitations doc promised: verify each `running`/`waiting` session's worktree still exists and its recorded pid is still alive; mark it `dead` and release its leases if either check fails.

**Accepted, documented limitation (not fixed here, not silently ignored):** `isProcessAlive` is `process.kill(pid, 0)` — it proves *some* process holds that pid, not that it's the same process this daemon spawned. After a daemon crash, if the OS recycles that pid for an unrelated process before the next boot, reconcile will wrongly treat the session as still alive. Verifying process identity (e.g. comparing `/proc/<pid>/cmdline` on Linux, `ps` output on macOS) is real, cross-platform-fragile work with a low-probability payoff — M1's own known-limitations doc already named this exact risk as the reason M0 never attempted reconciliation at all. This task closes the worktree-existence and pid-liveness checks it can close honestly; the residual pid-reuse risk is written up in the M2 known-limitations doc (Task 10) rather than either ignored or over-solved here.

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/reconciliation.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseRepo } from '../../src/db/repositories/lease.js';
import { reconcile } from '../../src/domain/reconciliation.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let sessions: SessionManager;
let workspaceId: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = new WorkspaceManager(db).init(fx.root).id;
  sessions = new SessionManager(db);
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('reconcile', () => {
  it('marks a running session dead when its worktree is gone', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    new SessionRepo(db).updateStatus(session.id, 'running', 99999);
    if (session.worktreePath !== null) await rm(session.worktreePath, { recursive: true, force: true });

    reconcile(db, fx.root);

    expect(sessions.resolve(workspaceId, session.id).status).toBe('dead');
  }, 30_000);

  it('marks a running session dead when its recorded pid is not alive', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    // A pid this high is essentially guaranteed not to exist.
    new SessionRepo(db).updateStatus(session.id, 'running', 9_999_999);

    reconcile(db, fx.root);

    expect(sessions.resolve(workspaceId, session.id).status).toBe('dead');
  }, 30_000);

  it('leaves an idle session alone', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    reconcile(db, fx.root);
    expect(sessions.resolve(workspaceId, session.id).status).toBe('idle');
  }, 30_000);

  it('releases leases for a session it marks dead', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    new SessionRepo(db).updateStatus(session.id, 'running', 9_999_999);
    const leases = new LeaseRepo(db);
    leases.insert({
      id: 'lease_test', sessionId: session.id, kind: 'port', value: '43000',
      acquiredAt: '2026-08-10T00:00:00.000Z', releasedAt: null,
    });

    reconcile(db, fx.root);

    expect(leases.listActive('port')).toHaveLength(0);
  }, 30_000);
});
```

The fields above (`id`, `sessionId`, `kind`, `value`, `acquiredAt`, `releasedAt`) are `LeaseRow`'s confirmed real shape from M1's `src/db/repositories/lease.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/domain/reconciliation.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/reconciliation.js`.

- [ ] **Step 3: Implement `src/domain/reconciliation.ts`**

```ts
import { existsSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { SessionRepo } from '../db/repositories/session.js';
import { LeaseRepo } from '../db/repositories/lease.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process — dead. EPERM: exists, owned by someone else — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reconcile daemon state once, at boot. Every session the DB believes is `running`
 * or `waiting` is necessarily a leftover from a PREVIOUS daemon — this instance has
 * not started anything yet — so each one is checked and, if stale, marked `dead`
 * with its leases released.
 *
 * Known, accepted limitation: `isProcessAlive` proves a pid is held by SOME process,
 * not that it's the one this session originally spawned. If the OS recycles a dead
 * agent's pid before this reconcile runs, a session can be wrongly left `running`.
 * Verifying process identity across macOS/Linux without a native dependency is
 * real, fragile extra work for a low-probability window; documented rather than
 * either ignored or over-built here — see the M2 known-limitations doc.
 */
export function reconcile(db: Database, _projectRoot: string): void {
  const sessions = new SessionRepo(db);
  const leases = new LeaseRepo(db);

  const workspaceIds = (
    db.prepare('SELECT id FROM workspace').all() as { id: string }[]
  ).map((r) => r.id);

  for (const workspaceId of workspaceIds) {
    for (const session of sessions.listLive(workspaceId)) {
      if (session.status !== 'running' && session.status !== 'waiting') continue;

      const worktreeGone = session.worktreePath !== null && !existsSync(session.worktreePath);
      const pidGone = typeof session.pid === 'number' ? !isProcessAlive(session.pid) : true;

      if (worktreeGone || pidGone) {
        sessions.updateStatus(session.id, 'dead', null);
        leases.release(session.id);
      }
    }
  }
}
```

**Plan/source divergence, found by Task 8's whole-branch-adjacent review, DoD-breaking:** the code above treats `worktreeGone` and `pidGone` as the same outcome — both mark `dead`. Task 8 wires `reconcile()` into the live boot path, and only then does this become reachable and destructive: a session that is merely `running` when the daemon dies (a crash, or an ordinary restart for `cw daemon stop`/an upgrade/a host reboot) gets marked `dead` on the next boot even though nothing was ever asked to kill it. `dead` means "deliberately killed, terminal" in this codebase's established semantics — `assertResumable` refuses to ever restart it, and a later `cw gc` deletes its worktree and branch. **An ordinary daemon restart permanently destroys any in-progress work that happened to be `running` at that moment** — the same class of bug as M1's boot-gc Critical #2, reproduced end to end: start a session, simulate a daemon crash+restart, the session becomes `dead`, `resume` throws `SESSION_ENDED`, `cw gc` deletes the worktree.

The fix distinguishes the two conditions instead of collapsing them: a gone worktree really does mean nothing is left to resume (`dead` is correct there), but a gone pid with the worktree still intact is functionally identical to what `cw session stop` already does on purpose — end the process, leave the session resumable. That case must mark `idle`, not `dead`.

```ts
      if (worktreeGone) {
        sessions.updateStatus(session.id, 'dead', null);
        leases.release(session.id);
      } else if (pidGone) {
        // Same outcome as `session.stop`: process ended, work stays resumable.
        sessions.updateStatus(session.id, 'idle', null);
        leases.release(session.id);
      }
```

Leases are released in both branches either way — a dead process can't hold live port/docker/cache resources regardless of which case applies. This also means the test two sections above — `marks a running session dead when its recorded pid is not alive` — is now wrong under the corrected code (that scenario is exactly the pid-gone-worktree-intact case) and must assert `idle`, not `dead`; a separate test for the genuinely-`dead` worktree-gone case stays as originally written.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/domain/reconciliation.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/domain/reconciliation.ts tests/domain/reconciliation.test.ts
git commit -m "feat(reconciliation): mark stale sessions dead and release their leases at daemon boot"
```

---

### Task 6: Hand-rolled MCP protocol + server

**Files:**
- Create: `src/mcp/protocol.ts`
- Create: `src/mcp/server.ts`
- Test: `tests/mcp/protocol.test.ts`

**Interfaces:**
- Consumes: `node:net`, `node:fs` (`chmodSync`, `existsSync`, `mkdirSync`, `unlinkSync`), `node:os` (`tmpdir`)
- Produces:
  - `interface McpTool { name: string; description: string; inputSchema: object; handler: (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> }`
  - `function framedLines(onMessage: (line: string) => void): { feed(chunk: Buffer | string): void }` — newline-delimited message reassembly for a stream that may deliver partial lines
  - `function handleMcpMessage(raw: string, tools: McpTool[]): Promise<string | undefined>` — parses one JSON-RPC line, dispatches `initialize` / `tools/list` / `tools/call`, returns the JSON-RPC response line to write back (or `undefined` for a notification, which gets no response)
  - `function mcpSocketPath(sessionId: string): string` — a short, safe-length path under `os.tmpdir()`
  - `function createMcpServer(sessionId: string, workspaceId: string, db: Database, tools: (workspaceId: string, sessionId: string, db: Database) => McpTool[]): { socketPath: string; close(): Promise<void> }`

**Corrected design vs. the reset attempt:** no `@modelcontextprotocol/sdk`, no `zod`. The wire format is exactly what `StdioServerTransport` speaks — newline-delimited JSON-RPC 2.0 — hand-framed here. The socket path moves from `<projectRoot>/.crossweave/mcp-<sessionId>.sock` (routinely too long for AF_UNIX's ~104/108-byte limit) to `join(tmpdir(), 'cw-mcp-' + sessionId + '.sock')`, with a safety fallback to a short hash if that's still too long. The listening server AND every accepted connection get an `'error'` listener attached before anything else can happen to them — the reset attempt had neither, so a bind failure threw with zero listeners and (with no top-level handler either — fixed in Task 8) crashed the whole daemon, taking every other running session down with it.

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp/protocol.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { framedLines, handleMcpMessage, mcpSocketPath, type McpTool } from '../../src/mcp/protocol.js';

describe('framedLines', () => {
  it('reassembles a message split across chunks', () => {
    const lines: string[] = [];
    const framer = framedLines((line) => lines.push(line));
    framer.feed('{"a":1}\n{"b":');
    framer.feed('2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles multiple messages in one chunk', () => {
    const lines: string[] = [];
    const framer = framedLines((line) => lines.push(line));
    framer.feed('one\ntwo\nthree\n');
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('ignores an empty line', () => {
    const lines: string[] = [];
    const framer = framedLines((line) => lines.push(line));
    framer.feed('\n\nreal\n');
    expect(lines).toEqual(['real']);
  });
});

describe('mcpSocketPath', () => {
  it('produces a path comfortably under the AF_UNIX limit', () => {
    const path = mcpSocketPath('s_01kzng781w00005byn0abcdefgh');
    expect(path.length).toBeLessThan(100);
  });

  it('produces distinct paths for distinct session ids', () => {
    expect(mcpSocketPath('s_a')).not.toBe(mcpSocketPath('s_b'));
  });
});

describe('handleMcpMessage', () => {
  const echoTool: McpTool = {
    name: 'echo',
    description: 'Echoes its input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (args) => ({ content: [{ type: 'text', text: String(args.text) }] }),
  };

  it('answers initialize', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      [echoTool],
    );
    const parsed = JSON.parse(response ?? '') as { result: { serverInfo: { name: string } } };
    expect(parsed.result.serverInfo.name).toBe('crossweave');
  });

  it('answers tools/list with the given tools', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      [echoTool],
    );
    const parsed = JSON.parse(response ?? '') as { result: { tools: { name: string }[] } };
    expect(parsed.result.tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('answers tools/call by invoking the matching tool', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'hi' } },
      }),
      [echoTool],
    );
    const parsed = JSON.parse(response ?? '') as { result: { content: { text: string }[] } };
    expect(parsed.result.content[0]?.text).toBe('hi');
  });

  it('tools/call with an unknown tool name returns an MCP-level error, not a crash', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ghost', arguments: {} } }),
      [echoTool],
    );
    const parsed = JSON.parse(response ?? '') as { result: { isError: boolean } };
    expect(parsed.result.isError).toBe(true);
  });

  it('a notification (no id) gets no response', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      [echoTool],
    );
    expect(response).toBeUndefined();
  });

  it('an unknown method returns a JSON-RPC protocol error', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ghost/method', params: {} }),
      [echoTool],
    );
    const parsed = JSON.parse(response ?? '') as { error: { code: number } };
    expect(parsed.error.code).toBe(-32601);
  });

  it('malformed JSON returns a parse error, not a thrown exception', async () => {
    const response = await handleMcpMessage('{ not json', [echoTool]);
    const parsed = JSON.parse(response ?? '') as { error: { code: number } };
    expect(parsed.error.code).toBe(-32700);
  });

  it('a tool handler that throws is caught and reported as an MCP-level error', async () => {
    const throwingTool: McpTool = {
      name: 'boom',
      description: 'Always throws',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('kaboom');
      },
    };
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'boom', arguments: {} } }),
      [throwingTool],
    );
    const parsed = JSON.parse(response ?? '') as { result: { isError: boolean; content: { text: string }[] } };
    expect(parsed.result.isError).toBe(true);
    expect(parsed.result.content[0]?.text).toContain('kaboom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/protocol.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/protocol.js`.

- [ ] **Step 3: Implement `src/mcp/protocol.ts`**

```ts
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

/**
 * Reassembles a byte stream into newline-delimited messages. A socket delivers
 * data in arbitrary chunks — a message can arrive split across two `data` events,
 * or two messages can arrive in one. This buffers the tail of an incomplete line
 * between calls and calls `onMessage` once per complete line.
 */
export function framedLines(onMessage: (line: string) => void): { feed(chunk: Buffer | string): void } {
  let buffer = '';
  return {
    feed(chunk: Buffer | string): void {
      buffer += chunk.toString('utf8');
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) onMessage(line);
        newlineIndex = buffer.indexOf('\n');
      }
    },
  };
}

const SOCKET_PATH_SAFE_MAX = 90; // margin under macOS's ~104 / Linux's ~108 byte AF_UNIX cap

/**
 * A short, stable, collision-free unix socket path for a session's MCP server.
 * Deliberately NOT under the project root — `<projectRoot>/.crossweave/mcp-<id>.sock`
 * routinely exceeds AF_UNIX's path-length limit once a project lives a few
 * directories deep, and a failed bind with no listener crashes the whole process
 * (see Task 8's top-level handler for the last line of defence; this is the first).
 */
export function mcpSocketPath(sessionId: string): string {
  const full = join(tmpdir(), `cw-mcp-${sessionId}.sock`);
  if (full.length <= SOCKET_PATH_SAFE_MAX) return full;
  // Fallback for an unusually long $TMPDIR or session id: a short stable hash still
  // guarantees no two sessions collide, just without the id being human-readable.
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return join(tmpdir(), `cw-mcp-${hash}.sock`);
}

const PROTOCOL_VERSION = '2024-11-05';

function ok(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function protocolError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Parses and dispatches one JSON-RPC 2.0 line. Returns the response line to write
 * back, or `undefined` for a notification (no `id`), which gets no response per
 * the JSON-RPC spec. Never throws — every failure mode (bad JSON, unknown method,
 * a tool handler that throws) becomes a JSON-RPC or MCP-level error response
 * instead, so one malformed message can never take down the connection.
 */
export async function handleMcpMessage(raw: string, tools: McpTool[]): Promise<string | undefined> {
  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return protocolError(null, -32700, 'Parse error');
  }

  const { id, method, params } = msg;
  const isNotification = id === undefined;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'crossweave', version: '0.0.0' },
    });
  }

  if (method === 'notifications/initialized') {
    return undefined; // acknowledged implicitly by continuing to serve requests
  }

  if (method === 'tools/list') {
    return ok(id, {
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : undefined;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) {
      if (isNotification) return undefined;
      return ok(id, { content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }], isError: true });
    }
    try {
      const result = await tool.handler(args);
      if (isNotification) return undefined;
      return ok(id, result);
    } catch (err) {
      if (isNotification) return undefined;
      const text = err instanceof Error ? err.message : String(err);
      return ok(id, { content: [{ type: 'text', text }], isError: true });
    }
  }

  if (isNotification) return undefined;
  return protocolError(id, -32601, `Method not found: ${String(method)}`);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/mcp/protocol.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Implement `src/mcp/server.ts`**

```ts
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { framedLines, handleMcpMessage, mcpSocketPath, type McpTool } from './protocol.js';

export interface McpServerHandle {
  socketPath: string;
  close(): Promise<void>;
}

/**
 * Starts a per-session MCP server on a unix domain socket. Both the listening
 * server and every accepted connection get an `'error'` listener attached before
 * anything else happens to them — an unlistened `'error'` event on a `node:net`
 * object throws by default, and with no top-level handler in the daemon process
 * (added separately in `src/daemon/main.ts`) that throw would kill the whole
 * daemon, not just this one session's server. A bind failure here is caught,
 * logged, and left as "this session has no MCP tools available" — degraded, not
 * catastrophic.
 */
export function createMcpServer(
  sessionId: string,
  tools: McpTool[],
): McpServerHandle {
  const socketPath = mcpSocketPath(sessionId);
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Best effort — a stale socket file from a previous run.
    }
  }

  const netServer: NetServer = createServer((socket: Socket) => {
    socket.on('error', () => {
      // A peer that goes away mid-write is not this process's problem.
    });

    const framer = framedLines((line) => {
      void handleMcpMessage(line, tools).then((response) => {
        if (response !== undefined && !socket.destroyed) {
          socket.write(response + '\n');
        }
      });
    });

    socket.on('data', (chunk) => framer.feed(chunk));
  });

  netServer.on('error', (err) => {
    process.stderr.write(`crossweave: MCP server for session ${sessionId} failed: ${String(err)}\n`);
  });

  netServer.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // Best effort — the socket still works even if the mode couldn't be tightened.
    }
  });

  return {
    socketPath,
    close(): Promise<void> {
      return new Promise((resolve) => {
        netServer.close(() => {
          if (existsSync(socketPath)) {
            try {
              unlinkSync(socketPath);
            } catch {
              // Best effort on close.
            }
          }
          resolve();
        });
      });
    },
  };
}
```

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all PASS (222 from M1 + new tests from Tasks 1-6), 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/protocol.ts src/mcp/server.ts tests/mcp/protocol.test.ts
git commit -m "feat(mcp): hand-rolled JSON-RPC MCP server, no SDK dependency"
```

---

### Task 7: The six real MCP tools

**Files:**
- Create: `src/mcp/tools.ts`
- Test: covered by Task 8's end-to-end tests (this task's own tests are the unit tests below)

**Interfaces:**
- Consumes: `McpTool` from `src/mcp/protocol.ts`, `MessageBus`, `ContextStore`
- Produces: `function buildTools(sessionId: string, workspaceId: string, bus: MessageBus, store: ContextStore): McpTool[]` — returns exactly six tools: `cw_send`, `cw_broadcast`, `cw_handoff`, `cw_inbox`, `cw_publish_context`, `cw_read_context`. **Not** `cw_check` or `cw_declare_contract` — see Global Constraints.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { MessageBus } from '../../src/domain/bus.js';
import { ContextStore } from '../../src/domain/context-store.js';
import { buildTools } from '../../src/mcp/tools.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let sessions: SessionManager;
let workspaceId: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = new WorkspaceManager(db).init(fx.root).id;
  sessions = new SessionManager(db);
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('buildTools', () => {
  it('exposes exactly the six real tools, never cw_check or cw_declare_contract', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const bus = new MessageBus(db, sessions);
    const store = new ContextStore(db);
    const tools = buildTools(a.id, workspaceId, bus, store);

    expect(tools.map((t) => t.name).sort()).toEqual([
      'cw_broadcast', 'cw_handoff', 'cw_inbox', 'cw_publish_context', 'cw_read_context', 'cw_send',
    ]);
  }, 30_000);

  it('cw_send delivers to the named recipient and cw_inbox on that session sees it', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    const bus = new MessageBus(db, sessions);
    const store = new ContextStore(db);
    const toolsA = buildTools(a.id, workspaceId, bus, store);
    const toolsB = buildTools(b.id, workspaceId, bus, store);

    const send = toolsA.find((t) => t.name === 'cw_send');
    if (send === undefined) throw new Error('expected cw_send');
    await send.handler({ toSession: 'b', body: 'hi' });

    const inbox = toolsB.find((t) => t.name === 'cw_inbox');
    if (inbox === undefined) throw new Error('expected cw_inbox');
    const result = await inbox.handler({});
    const parsed = JSON.parse(result.content[0]?.text ?? '[]') as { body: string; from: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.body).toBe('hi');
  }, 30_000);

  it('cw_handoff carries contextRef through cw_inbox', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    const bus = new MessageBus(db, sessions);
    const store = new ContextStore(db);
    const toolsA = buildTools(a.id, workspaceId, bus, store);
    const toolsB = buildTools(b.id, workspaceId, bus, store);

    const publish = toolsA.find((t) => t.name === 'cw_publish_context');
    const handoff = toolsA.find((t) => t.name === 'cw_handoff');
    const inbox = toolsB.find((t) => t.name === 'cw_inbox');
    if (!publish || !handoff || !inbox) throw new Error('expected tools');

    const published = await publish.handler({ key: 'plan', body: 'the plan' });
    const publishedRef = (JSON.parse(published.content[0]?.text ?? '{}') as { id: string }).id;
    await handoff.handler({ toSession: 'b', body: 'take over', contextRef: publishedRef });

    const result = await inbox.handler({});
    const parsed = JSON.parse(result.content[0]?.text ?? '[]') as { contextRef: string | null }[];
    expect(parsed[0]?.contextRef).toBe(publishedRef);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/tools.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/tools.js`.

- [ ] **Step 3: Implement `src/mcp/tools.ts`**

```ts
import type { McpTool, McpToolResult } from './protocol.js';
import type { MessageBus } from '../domain/bus.js';
import type { ContextStore } from '../domain/context-store.js';

function text(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Expected a non-empty string for "${key}"`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

/** Exactly the six real tools. `cw_check` and `cw_declare_contract` arrive in M3. */
export function buildTools(
  sessionId: string,
  workspaceId: string,
  bus: MessageBus,
  store: ContextStore,
): McpTool[] {
  return [
    {
      name: 'cw_send',
      description: 'Send a direct message to another session in this workspace, by name or id.',
      inputSchema: {
        type: 'object',
        properties: {
          toSession: { type: 'string', description: 'Target session id or name' },
          body: { type: 'string', description: 'Message body (max 8 KB)' },
        },
        required: ['toSession', 'body'],
      },
      handler: async (args) => {
        const toSession = requireString(args, 'toSession');
        const body = requireString(args, 'body');
        bus.send({ workspaceId, fromSession: sessionId, toSession, body, trust: 'agent' });
        return text('sent');
      },
    },
    {
      name: 'cw_broadcast',
      description: 'Broadcast a message to every other live session in this workspace.',
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'string', description: 'Message body (max 8 KB)' } },
        required: ['body'],
      },
      handler: async (args) => {
        const body = requireString(args, 'body');
        const sent = bus.broadcast({ workspaceId, fromSession: sessionId, body, trust: 'agent' });
        return text(`broadcast sent to ${sent.length} session(s)`);
      },
    },
    {
      name: 'cw_handoff',
      description: 'Hand off work to another session, optionally attaching a published context entry.',
      inputSchema: {
        type: 'object',
        properties: {
          toSession: { type: 'string', description: 'Target session id or name' },
          body: { type: 'string', description: 'Handoff summary' },
          contextRef: { type: 'string', description: 'Id of a context entry published via cw_publish_context' },
        },
        required: ['toSession', 'body'],
      },
      handler: async (args) => {
        const toSession = requireString(args, 'toSession');
        const body = requireString(args, 'body');
        const contextRef = optionalString(args, 'contextRef');
        bus.handoff({ workspaceId, fromSession: sessionId, toSession, body, trust: 'agent', contextRef });
        return text('handoff sent');
      },
    },
    {
      name: 'cw_inbox',
      description: "List this session's undelivered messages (direct, broadcast and handoff alike).",
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const messages = bus.inbox(workspaceId, sessionId);
        return text(
          messages.map((m) => ({
            id: m.id,
            from: m.fromSession,
            type: m.type,
            body: m.body,
            contextRef: m.contextRef,
            trust: m.trust,
            createdAt: m.createdAt,
          })),
        );
      },
    },
    {
      name: 'cw_publish_context',
      description: 'Publish a context entry visible to every session in this workspace. Returns its id for handoff.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Entry key' },
          body: { type: 'string', description: 'Entry body (max 64 KB)' },
        },
        required: ['key', 'body'],
      },
      handler: async (args) => {
        const key = requireString(args, 'key');
        const body = requireString(args, 'body');
        const entry = store.publish(workspaceId, sessionId, key, body);
        return text({ id: entry.id, key: entry.key });
      },
    },
    {
      name: 'cw_read_context',
      description: 'Read every shared context entry in this workspace.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const entries = store.readShared(workspaceId);
        return text(entries.map((e) => ({ id: e.id, sessionId: e.sessionId, key: e.key, body: e.body, createdAt: e.createdAt })));
      },
    },
  ];
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/mcp/tools.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/tools.test.ts
git commit -m "feat(mcp): the six real crossweave tools — cw_check/cw_declare_contract deferred to M3"
```

---

### Task 8: Wire it all into the daemon

**Files:**
- Modify: `src/daemon/methods.ts`
- Modify: `src/daemon/main.ts`
- Test: `tests/mcp/mcp-server.test.ts` (real socket, end-to-end)

**Interfaces:**
- Consumes: everything from Tasks 2-7
- Produces: RPC method `blame`; MCP server lifecycle tied to session start/exit/shutdown; `reconcile()` called once at boot; `session.started` events recorded

- [ ] **Step 1: Write the failing end-to-end test**

Create `tests/mcp/mcp-server.test.ts` — this is the test that actually proves the wiring works, not just each piece in isolation. It speaks the real protocol over a real unix socket, exactly as an MCP client would.

**Starting a session must not spawn the real `claude` binary** — it isn't present in the test environment. `tests/daemon/runtime.test.ts` already solves this by passing a fake `adapterFactory` (an `echoFactory` that runs `sh` instead of `claude`) as `buildMethods`'s third argument; this test reuses the exact same pattern:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DaemonClient } from '../../src/client/rpc-client.js';
import { ClaudePtyAdapter } from '../../src/adapters/claude-pty.js';
import { CrossweaveError } from '../../src/core/errors.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

/** Never spawns the real `claude` binary — see tests/daemon/runtime.test.ts's identical helper. */
function echoFactory(kind: string): AgentAdapter {
  if (kind !== 'claude') throw new CrossweaveError('UNKNOWN_AGENT', `Unsupported: ${kind}`);
  return new ClaudePtyAdapter('sh', ['-c', 'while IFS= read -r l; do eval "echo echo:$l"; done']);
}

let fx: GitFixture;
let db: Database;
let daemon: Daemon | undefined;
let client: DaemonClient | undefined;
let socketPath: string;

async function callMcp(mcpSocketPath: string, method: string, params: Record<string, unknown>, id = 1): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(mcpSocketPath);
    let buffer = '';
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      sock.end();
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  });
}

beforeEach(async () => {
  fx = await makeGitFixture();
  socketPath = join(fx.root, '.crossweave', 'daemon.sock');
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root, echoFactory) });
  await daemon.listen();
  client = await DaemonClient.connect(socketPath);
});

afterEach(async () => {
  client?.close();
  await daemon?.close();
  db.close();
  await fx.cleanup();
});

describe('MCP server end-to-end', () => {
  it('two sessions exchange a message through their real MCP sockets', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    const a = await client.call<{ id: string; name: string }>('session.new', {
      workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: false,
    });
    const b = await client.call<{ id: string; name: string }>('session.new', {
      workspaceId: workspace.id, name: 'b', agent: 'claude', worktree: false,
    });
    await client.call('session.start', { workspaceId: workspace.id, idOrName: 'a', env: {} });
    await client.call('session.start', { workspaceId: workspace.id, idOrName: 'b', env: {} });

    const startedA = await client.call<{ mcpSocketPath: string }>('session.mcpInfo', {
      workspaceId: workspace.id, idOrName: 'a',
    });
    const startedB = await client.call<{ mcpSocketPath: string }>('session.mcpInfo', {
      workspaceId: workspace.id, idOrName: 'b',
    });

    await callMcp(startedA.mcpSocketPath, 'tools/call', { name: 'cw_send', arguments: { toSession: 'b', body: 'hi from a' } });

    const inboxResponse = (await callMcp(startedB.mcpSocketPath, 'tools/call', { name: 'cw_inbox', arguments: {} })) as {
      result: { content: { text: string }[] };
    };
    const messages = JSON.parse(inboxResponse.result.content[0]?.text ?? '[]') as { body: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe('hi from a');
  }, 30_000);

  it('a broadcast reaches multiple sessions but not the sender', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    await client.call('session.new', { workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: false });
    await client.call('session.new', { workspaceId: workspace.id, name: 'b', agent: 'claude', worktree: false });
    await client.call('session.new', { workspaceId: workspace.id, name: 'c', agent: 'claude', worktree: false });
    for (const name of ['a', 'b', 'c']) {
      await client.call('session.start', { workspaceId: workspace.id, idOrName: name, env: {} });
    }

    const infoFor = async (name: string) =>
      client!.call<{ mcpSocketPath: string }>('session.mcpInfo', { workspaceId: workspace.id, idOrName: name });
    const [a, b, c] = await Promise.all([infoFor('a'), infoFor('b'), infoFor('c')]);
    if (!a || !b || !c) throw new Error('expected mcp info for all three');

    await callMcp(a.mcpSocketPath, 'tools/call', { name: 'cw_broadcast', arguments: { body: 'build is red' } });

    for (const info of [b, c]) {
      const response = (await callMcp(info.mcpSocketPath, 'tools/call', { name: 'cw_inbox', arguments: {} })) as {
        result: { content: { text: string }[] };
      };
      const messages = JSON.parse(response.result.content[0]?.text ?? '[]') as unknown[];
      expect(messages).toHaveLength(1);
    }
    const aInbox = (await callMcp(a.mcpSocketPath, 'tools/call', { name: 'cw_inbox', arguments: {} })) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(aInbox.result.content[0]?.text ?? '[]')).toHaveLength(0);
  }, 30_000);
});
```

This test calls a new RPC method, `session.mcpInfo`, that doesn't exist yet — it's the cleanest way for a client to learn its own session's MCP socket path without hardcoding the naming scheme from Task 6. Add it in Step 3 below.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/mcp/mcp-server.test.ts`
Expected: FAIL — `session.mcpInfo` doesn't exist yet, and no MCP server has been wired to session start.

- [ ] **Step 3: Wire everything into `src/daemon/methods.ts`**

Add these imports near the top, alongside the existing ones:

```ts
import { EventLedger } from '../domain/ledger.js';
import { MessageBus } from '../domain/bus.js';
import { ContextStore } from '../domain/context-store.js';
import { reconcile } from '../domain/reconciliation.js';
import { createMcpServer, type McpServerHandle } from '../mcp/server.js';
import { buildTools } from '../mcp/tools.js';
```

Inside `buildMethods`, right after `const leaseManager = new LeaseManager(...)` and `leaseManager.releaseAll();`, add:

```ts
  const ledger = new EventLedger(db, projectRoot);
  const bus = new MessageBus(db, sessions);
  const contextStore = new ContextStore(db);

  // Once, at boot: every `running`/`waiting` session in the DB is necessarily a
  // leftover from a previous daemon instance, since this one hasn't started
  // anything yet. See src/domain/reconciliation.ts for what this does and does not
  // catch.
  reconcile(db, projectRoot);
```

Add a map for live MCP server handles, alongside the existing `starting` set:

```ts
  const mcpServers = new Map<string, McpServerHandle>();
```

Replace the body of the `start` function (the one defined around the `starting` set) so MCP-server creation and the `session.started` event happen after the session is confirmed running, and so an MCP-server failure degrades that one session instead of failing the whole start:

```ts
  async function start(p: Record<string, unknown>): Promise<SessionRow> {
    const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
    assertResumable(row);
    if (starting.has(row.id)) {
      throw new CrossweaveError('SESSION_ALREADY_RUNNING', `Session already starting: ${row.name}`);
    }
    starting.add(row.id);
    try {
      const env = { ...clientEnv(p), ...(await leaseManager.acquire(row.id)) };
      const pid = runtime.start(row, sessions.adapterFor(row.agentKind), env);
      sessions.markStatus(row.id, 'running', pid);
      ledger.append({ sessionId: row.id, workspaceId: row.workspaceId, kind: 'session.started', payload: '{}' });

      // Best effort: messaging/context tools are a real feature but not the reason
      // the session exists. A socket bind failure here (see mcpSocketPath's own
      // length guard, and main.ts's top-level handler) degrades this one session
      // to "no MCP tools available" rather than failing the whole start.
      try {
        const tools = buildTools(row.id, row.workspaceId, bus, contextStore);
        mcpServers.set(row.id, createMcpServer(row.id, tools));
      } catch (err) {
        process.stderr.write(`crossweave: could not start MCP server for session ${row.name}: ${String(err)}\n`);
      }

      return sessions.resolve(row.workspaceId, row.id);
    } finally {
      starting.delete(row.id);
    }
  }
```

Replace the runtime's exit callback (currently `sessions.clearRunning(sessionId); leaseManager.release(sessionId);`) so it closes that session's MCP server, deleting the map entry only once close genuinely resolves — this is what makes `daemon.shutdown`'s own close-everything pass (added below) able to catch a server that's still mid-close:

```ts
  const runtime = new SessionRuntime((sessionId) => {
    sessions.clearRunning(sessionId);
    leaseManager.release(sessionId);
    const handle = mcpServers.get(sessionId);
    if (handle !== undefined) {
      void handle
        .close()
        .catch(() => undefined)
        .finally(() => mcpServers.delete(sessionId));
    }
  });
```

Add `blame` and `session.mcpInfo` to the returned methods object, and extend `session.stop` and `daemon.shutdown`:

```ts
    blame: (p) => {
      const result = ledger.blame(str(p, 'workspaceId'), str(p, 'file'), num(p, 'line'));
      return result ?? null;
    },

    'session.mcpInfo': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      const handle = mcpServers.get(row.id);
      if (handle === undefined) {
        throw new CrossweaveError('MCP_SERVER_NOT_RUNNING', `No MCP server is running for session ${row.name}`);
      }
      return { mcpSocketPath: handle.socketPath };
    },
```

Change `session.stop` to also close (and remove) that session's MCP server:

```ts
    'session.stop': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      await runtime.stop(row.id);
      leaseManager.release(row.id);
      const handle = mcpServers.get(row.id);
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
        mcpServers.delete(row.id);
      }
      return { ok: true };
    },
```

Change `daemon.shutdown` to await closing every MCP server still tracked — this is the pass that catches a server whose close was kicked off by the exit callback above but hadn't resolved yet when shutdown was requested:

```ts
    'daemon.shutdown': async () => {
      await runtime.stopAll();
      await Promise.all([...mcpServers.values()].map((h) => h.close().catch(() => undefined)));
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },
```

- [ ] **Step 4: Add the top-level daemon safety net in `src/daemon/main.ts`**

Add these two handlers before `void main();` at the bottom of the file:

```ts
// Last line of defence: an MCP server's own 'error' listener (src/mcp/server.ts) is
// the first line, but any other unexpected error in this process must not take down
// every session's agent process just because one thing went wrong. Log it and keep
// serving — a daemon that's still up for the other N sessions beats one that isn't
// up for any of them.
process.on('uncaughtException', (err) => {
  process.stderr.write(`crossweave: uncaught exception in daemon: ${String(err)}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`crossweave: unhandled rejection in daemon: ${String(reason)}\n`);
});
```

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all PASS. This includes the end-to-end test from Step 1 actually passing — two real sessions, two real sockets, a real message and a real broadcast.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/methods.ts src/daemon/main.ts tests/mcp/mcp-server.test.ts
git commit -m "feat(daemon): wire ledger, bus, context store, reconciliation and MCP lifecycle into buildMethods"
```

---

### Task 9: `cw blame` CLI command

**Files:**
- Create: `src/cli/commands/blame.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/blame.test.ts`

**Interfaces:**
- Consumes: `withClient`, `fail`, `currentWorkspaceId` (or the equivalent already used by other commands — check `src/cli/commands/session.ts` for the exact pattern before writing this), RPC method `blame`
- Produces: `cw blame <file>:<line>`

- [ ] **Step 1: Write the failing test**

`tests/cli/cli.test.ts`'s `cw()` helper is module-local (not exported) and hardcodes its own fixture's root as the spawned process's cwd — this test file defines its own copy of the same pattern rather than importing it, exactly like every other CLI test file in this codebase does. `session new`'s stdout is tab-separated: `name\tstatus\tenforcementTier\tworktreePath` (confirmed against `src/cli/commands/session.ts`) — index 3 is the worktree path, the same field `tests/cli/cli.test.ts` already reads this way.

Create `tests/cli/blame.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { commitFile, makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

const CLI = new URL('../../src/cli/index.ts', import.meta.url).pathname;
let fx: GitFixture;

interface CwResult { exitCode: number; stdout: string; stderr: string }

async function cw(args: string[]): Promise<CwResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { cwd: fx.root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

beforeEach(async () => {
  fx = await makeGitFixture();
});

afterEach(async () => {
  await cw(['daemon', 'stop']);
  await fx.cleanup();
});

describe('cw blame', () => {
  it('attributes a committed line to the session that made the commit', async () => {
    await cw(['init']);
    const created = await cw(['session', 'new', '--name', 'auth', '--agent', 'claude']);
    const worktreePath = created.stdout.trim().split('\t')[3];
    if (worktreePath === undefined || worktreePath === '-') throw new Error('expected a worktree path');
    await commitFile(worktreePath, 'auth.ts', 'export const x = 1;\n', 'add auth.ts');

    const r = await cw(['blame', 'auth.ts:1']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('auth');
  }, 30_000);

  it('reports no attribution for an unknown file, cleanly', async () => {
    await cw(['init']);
    const r = await cw(['blame', 'nope.ts:1']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('no attribution');
  }, 30_000);

  it('rejects a malformed target with a CODE: line', async () => {
    await cw(['init']);
    const r = await cw(['blame', 'not-a-valid-target']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^[A-Z_]+: /);
  }, 30_000);

  it('rejects a non-numeric line with a CODE: line', async () => {
    await cw(['init']);
    const r = await cw(['blame', 'auth.ts:notanumber']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^INVALID_ARGUMENTS: /);
  }, 30_000);
});
```

Use the SAME commit-then-blame flow Task 2's `tests/domain/ledger.test.ts` already proved works — this CLI test validates the command's plumbing (argument parsing, RPC call, output formatting), not blame's correctness, which is already covered.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/blame.test.ts`
Expected: FAIL — no `blame` command registered.

- [ ] **Step 3: Implement `src/cli/commands/blame.ts`**

Same shape as `src/cli/commands/workspace.ts`'s `gcCommand` — a simple, no-flag `withClient`-based command — using the already-exported `currentWorkspaceId` helper from `src/cli/context.ts` (`withClient`, `fail`, `currentWorkspaceId` are all confirmed-existing exports as of M1):

```ts
import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { CrossweaveError } from '../../core/errors.js';

interface BlameResult {
  sessionId: string;
  sessionName: string;
  commitHash: string;
}

export const blameCommand = defineCommand({
  meta: { name: 'blame', description: 'Show which session committed a line' },
  args: {
    target: { type: 'positional', description: '<file>:<line>' },
  },
  async run({ args }) {
    try {
      const separatorIndex = args.target.lastIndexOf(':');
      if (separatorIndex === -1) {
        throw new CrossweaveError('INVALID_ARGUMENTS', 'Expected <file>:<line>, e.g. src/auth.ts:42');
      }
      const file = args.target.slice(0, separatorIndex);
      const lineText = args.target.slice(separatorIndex + 1);
      const line = Number(lineText);
      if (!Number.isInteger(line) || line < 1) {
        throw new CrossweaveError('INVALID_ARGUMENTS', `Expected a positive line number, got: ${lineText}`);
      }

      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const result = await client.call<BlameResult | null>('blame', { workspaceId, file, line });
        if (result === null) {
          process.stdout.write(`no attribution found for ${file}:${line}\n`);
          return;
        }
        process.stdout.write(`${file}:${line} — ${result.sessionName} (commit ${result.commitHash.slice(0, 8)})\n`);
      });
    } catch (err) { fail(err); }
  },
});
```

`withClient`, `fail`, `currentWorkspaceId` are all real, already-exported names from `src/cli/context.js`.

- [ ] **Step 4: Register the command**

In `src/cli/index.ts`, add `blame: blameCommand` to `subCommands`, importing it from `./commands/blame.js`.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/cli/blame.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 6: Run the whole suite**

Run: `bun test && bun run typecheck && bun run build`
Expected: all PASS, 0 type errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/blame.ts src/cli/index.ts tests/cli/blame.test.ts
git commit -m "feat(cli): cw blame <file>:<line>"
```

---

### Task 10: M2 known-limitations doc

**Files:**
- Create: `docs/superpowers/specs/2026-08-10-m2-known-limitations.md`

Mirror the M0 and M1 known-limitations docs' format and tone. Cover, honestly, what this plan explicitly scoped out rather than solved:

- **Blame only attributes committed lines.** An uncommitted change has no session to attribute it to without a file-change hook — that arrives with M3's `PreToolUse` plumbing. `cw blame` says so plainly (`no attribution found`) rather than guessing.
- **Blame history is lost once a session's row is deleted.** `event.session_id` cascades on session deletion, same as M1's lease table. A session that's merely `kill`ed (not `--rm-worktree`/`rm`/`gc`'d) keeps its full event history; a fully-reclaimed session's is gone. Extending audit history to outlive the session row is a real but separate design change (nullable `session_id`, or a durable append-only export) — not attempted here.
- **Reconciliation's pid-liveness check can be fooled by pid reuse after a crash.** Documented in `src/domain/reconciliation.ts`'s own docstring and repeated here: this is the same risk M0's known-limitations doc named as the reason M0 never attempted reconciliation. M2 closes the worktree-existence and pid-liveness checks; verifying process identity across macOS/Linux without a native dependency is real, fragile extra work for a low-probability window, left for whenever it's actually worth the cost.
- **Broadcast reaches sessions live at the moment it's sent, not sessions that start later.** A deliberate simplification over per-recipient delivery tracking for a topic-style "anyone, ever" broadcast — see Task 3's design note.
- **`cw_check` and `cw_declare_contract` are not implemented.** They arrive with M3's Collision Radar. No MCP tool by either name exists in M2 — an agent that tries to call one gets a clean "unknown tool" MCP error, not a fake success.

Then:

- [ ] **Step 1: Write the doc, following the M0/M1 docs' structure (Date/Status header, numbered sections, one limitation per subsection with what it is and why it's accepted).**

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-10-m2-known-limitations.md
git commit -m "docs: record M2's known limitations for M3"
```

---

## M2 Definition of Done

- `bun test && bun run typecheck && bun run build` is green.
- **`cw blame <file>:<line>` finds a real answer for a line an agent session actually committed** — verified end to end (Task 2's ledger tests, Task 9's CLI test), not just unit-tested in isolation.
- **Two sessions exchange a message through their real MCP sockets** — verified by actually connecting to both sockets and speaking the wire protocol (Task 8's end-to-end test), not by calling `MessageBus` directly and assuming the socket layer works.
- **A broadcast reaches every other live session and only those sessions** — verified the same way.
- **No `@modelcontextprotocol/sdk`, no `zod`, no new runtime dependency of any kind.** `bun pm ls` plus a check for `preinstall`/`install`/`postinstall` still shows exactly `simple-git` and `citty` as direct runtime dependencies, matching M0/M1.
- **A session whose MCP socket fails to bind does not take down the daemon.** The daemon keeps running every other session; only that one session loses its MCP tools.
- **`cw_check` and `cw_declare_contract` do not exist as callable tools in M2.** `tools/list` over any session's MCP socket lists exactly the six real tools.
- Reconciliation runs once at boot and is the only call site — no dead "known to this daemon" parameter that never fires.
- Every new error path exits non-zero with exactly one `CODE: message` line: `MESSAGE_TOO_LARGE`, `CONTEXT_TOO_LARGE`, `MCP_SERVER_NOT_RUNNING`, `INVALID_ARGUMENTS` (from `cw blame`'s target parsing), plus `SESSION_NOT_FOUND` reused correctly when a message's `toSession` doesn't resolve.
- M2 known-limitations doc committed.

## Deferred to M3 and beyond (explicitly not in M2)

`cw_check` / Collision Radar (file+symbol index, contracts, subscriptions, the `PreToolUse` hook that would let blame attribute uncommitted lines too), `cw_declare_contract`, process-identity verification for reconciliation (beyond pid-liveness), durable blame/event history across session deletion, per-recipient broadcast delivery tracking for sessions that join late.
