# crossweave M3 — Collision Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every live session a continuously updated picture of what every
other session in the workspace is touching (file- and symbol-level), surface
collisions to Claude Code sessions through a `PreToolUse` hook and to every
session through an MCP tool, and let a session declare a stable public
contract that auto-notifies whoever depends on it.

**Architecture:** A per-session, debounced `fs.watch` feeds a git-diff-driven
indexer that extracts changed top-level symbols with `web-tree-sitter` and
upserts them into a new `file_claim` table. A `radar.check` RPC answers "who
else has divergent claims here" from that table. Three delivery paths reach
that answer: a new `cw radar-hook` CLI subcommand wired automatically into
`ClaudePtyAdapter`'s spawn via a per-invocation `--settings` `PreToolUse`
hook, a new `cw_check` MCP tool, and — for sessions with neither — a
retroactive system message through the existing `MessageBus`. A `contract`
table lets a session pin a symbol's public signature; a re-index that changes
it notifies every session referencing that symbol.

**Tech Stack:** Bun ≥1.3.5, TypeScript, `bun:sqlite`, `bun test`,
`web-tree-sitter` (new), `simple-git`, `citty`, Node's built-in `fs.watch`.

## Global Constraints

- Runtime dependencies are exactly `citty`, `simple-git`, and — as of this
  plan — `web-tree-sitter`. This is the project's third and final declared
  runtime dependency, an explicit exception mirroring M0's `tsc`
  prebuilt-binary ruling (see
  `docs/superpowers/specs/2026-08-11-crossweave-m3-collision-radar-design.md`
  §2.1). It is a pure-WASM runtime with no native `.node` binding, and its
  own `package.json` declares no `preinstall`/`install`/`postinstall` script
  (verified against the published `web-tree-sitter@0.26.12` tarball during
  planning — its only `scripts` entries are `build:*`, `lint`, `test`,
  `prepack`, `postpack`, `prepublishOnly`).
- Grammar `.wasm` files for TypeScript, TSX, JavaScript and Python are
  **committed as static binary assets** under `assets/grammars/`, sourced
  from pinned versions of `tree-sitter-typescript@0.23.2`,
  `tree-sitter-javascript@0.25.0` and `tree-sitter-python@0.25.0` via the
  jsdelivr CDN, sha256-verified. **Those three packages are never added as a
  dependency of any kind** — each ships `"install": "node-gyp-build"` plus
  six platform-specific native `.node` prebuilds, which would violate both
  the zero-native-module and zero-install-script rules if installed. Fetching
  only the one static `.wasm` asset each package publishes, over plain HTTPS,
  sidesteps both.
- `SCHEMA_VERSION` moves from 4 to 5. Migrations remain lists of single
  statements (never a multi-statement blob), matching every existing entry in
  `src/db/schema.ts`.
- Every RPC method added to `src/daemon/methods.ts` uses the existing
  `str`/`optionalStr`/`bool`/`num` param helpers and throws `CrossweaveError`
  with an `UPPER_SNAKE_CASE` code on invalid input — the same contract every
  M0–M2 method already follows.
- Any external-origin path or symbol string (hook stdin, MCP tool arguments,
  CLI arguments) is passed through `assertContained` (`src/core/paths.ts`)
  before it touches the filesystem or a `git`/`ripgrep` invocation — the same
  rule M1's Task 8 fix enforced for `db.url`.
- M3 is advisory-only end to end: the `PreToolUse` hook this plan wires
  always returns `hookSpecificOutput.permissionDecision: "allow"`. Blocking
  (`"deny"`) is out of scope until M5's ACP-backed Safe Mode.
- **Sandboxed dev/CI environments do not reliably deliver OS-level
  file-change notifications.** Confirmed during planning: an unmodified
  `node:fs.watch` on a temp directory produced zero events for real writes
  made from inside this project's own sandboxed shell tool, while the
  identical script fired normally outside that sandbox. Every task touching
  `fs.watch` keeps the OS call itself as a thin, minimally-tested wiring
  layer (2–5 lines) and puts all real logic — debounce timing, the reindex
  pipeline — behind a directly callable, directly testable function that
  never depends on a live filesystem event actually arriving in a test run.
- New source lives under `src/radar/` (parsing, indexing, collision
  detection, noise control — mirrors the existing `src/mcp/` and
  `src/isolation/` per-concern directories) and `src/db/repositories/` for
  the three new tables, following the codebase's established repo/domain
  split (`*Repo` classes do raw SQL and camelCase↔snake_case mapping only;
  domain classes hold behavior).

---

### Task 1: `web-tree-sitter` dependency and grammar assets

**Files:**
- Modify: `package.json`
- Create: `assets/grammars/tree-sitter-typescript.wasm` (binary)
- Create: `assets/grammars/tree-sitter-tsx.wasm` (binary)
- Create: `assets/grammars/tree-sitter-javascript.wasm` (binary)
- Create: `assets/grammars/tree-sitter-python.wasm` (binary)
- Create: `assets/grammars/CHECKSUMS.sha256`
- Create: `assets/grammars/README.md`
- Create: `scripts/fetch-grammars.ts`

**Interfaces:**
- Produces: the four `.wasm` files at fixed, known paths under
  `assets/grammars/`, which Task 3 imports directly
  (`import tsWasm from '../../assets/grammars/tree-sitter-typescript.wasm' with { type: 'file' }`).
  No other task in this plan calls `fetch-grammars.ts` — it is a
  maintainer/CI tool for regenerating the committed assets when a grammar
  version is bumped, never invoked at `bun install` time or by any other
  task's code.

- [ ] **Step 1: Add the runtime dependency**

```bash
bun add web-tree-sitter@0.26.12
```

Verify no install-time script ran and no native module was pulled in:

```bash
grep -A2 '"scripts"' node_modules/web-tree-sitter/package.json
```

Expected: only `build:*`, `lint`, `test`, `prepack`, `postpack`,
`prepublishOnly` — no `install`/`postinstall`/`preinstall`.

- [ ] **Step 2: Write the grammar-fetch script**

```ts
// scripts/fetch-grammars.ts
//
// Maintainer tool: (re)downloads the pinned grammar .wasm files into
// assets/grammars/ and verifies each against its known sha256. Run by hand
// when bumping a grammar version — never part of `bun install` or any
// runtime code path. Network access is to cdn.jsdelivr.net only, which
// serves files straight out of the published npm tarball unmodified.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface GrammarAsset {
  file: string;
  url: string;
  sha256: string;
}

const OUT_DIR = join(import.meta.dir, '..', 'assets', 'grammars');

const ASSETS: GrammarAsset[] = [
  {
    file: 'tree-sitter-typescript.wasm',
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-typescript@0.23.2/tree-sitter-typescript.wasm',
    sha256: '778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d',
  },
  {
    file: 'tree-sitter-tsx.wasm',
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-typescript@0.23.2/tree-sitter-tsx.wasm',
    sha256: '79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8',
  },
  {
    file: 'tree-sitter-javascript.wasm',
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-javascript@0.25.0/tree-sitter-javascript.wasm',
    sha256: '5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240',
  },
  {
    file: 'tree-sitter-python.wasm',
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-python@0.25.0/tree-sitter-python.wasm',
    sha256: '16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47',
  },
];

async function fetchOne(asset: GrammarAsset): Promise<void> {
  const res = await fetch(asset.url);
  if (!res.ok) throw new Error(`fetch failed for ${asset.url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== asset.sha256) {
    throw new Error(
      `checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${actual}. ` +
        'The CDN may be serving a different build than the one this script was pinned against — do not overwrite the committed asset without investigating.',
    );
  }
  await writeFile(join(OUT_DIR, asset.file), bytes);
  console.log(`ok: ${asset.file} (${bytes.length} bytes, sha256 verified)`);
}

for (const asset of ASSETS) {
  await fetchOne(asset);
}
console.log('all grammar assets fetched and verified');
```

- [ ] **Step 3: Run it and commit the resulting assets**

```bash
bun run scripts/fetch-grammars.ts
shasum -a 256 assets/grammars/*.wasm > assets/grammars/CHECKSUMS.sha256
```

(`shasum` ships with macOS by default; `sha256sum` does not on every system —
prefer `shasum -a 256` for this project's darwin+linux target.)

If `cdn.jsdelivr.net` is unreachable from the current sandbox, retry the
command with the sandbox disabled for this one call — this is a one-time
maintainer step, not something that runs in the shipped product.

- [ ] **Step 4: Document provenance**

```markdown
<!-- assets/grammars/README.md -->
# Grammar assets

Pre-built `web-tree-sitter` grammar `.wasm` files, fetched from the pinned
npm package versions listed in `scripts/fetch-grammars.ts` and verified
against `CHECKSUMS.sha256`. These are the ONLY artifact taken from
`tree-sitter-typescript`, `tree-sitter-javascript` and `tree-sitter-python` —
none of those three packages is a project dependency (each carries native
`.node` prebuilds and an `install` script that would violate this project's
zero-native/zero-install-script rule; see the M3 design doc §2.1 and this
plan's Global Constraints).

To bump a grammar version: edit the version + URL + expected sha256 in
`scripts/fetch-grammars.ts`, then run `bun run scripts/fetch-grammars.ts`
and commit the updated `.wasm` files together with the script change.
```

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock assets/grammars scripts/fetch-grammars.ts
git commit -m "build: add web-tree-sitter dependency and grammar assets"
```

---

### Task 2: `file_claim`, `contract`, `contract_sub` schema and repositories

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/repositories/file-claim.ts`
- Create: `src/db/repositories/contract.ts`
- Test: `tests/db/file-claim-repo.test.ts`
- Test: `tests/db/contract-repo.test.ts`

**Interfaces:**
- Produces: `FileClaimRepo` (`findOne`, `upsert`, `deleteOne`,
  `deleteBySession`, `listByWorkspacePath`, `listBySession`),
  `ContractRepo` (`insert`, `findByFqn`, `updateSigHash`, `addSubscriber`,
  `listSubscribers`), and their row types `FileClaimRow`, `ContractRow`,
  `ContractSubRow` — Task 4 (indexer) and Task 6 (collision check) consume
  `FileClaimRepo`; Task 8 (contracts) consumes `ContractRepo`.

- [ ] **Step 1: Write the migration**

```ts
// Appended to MIGRATIONS in src/db/schema.ts; bump the top-of-file constant first:
export const SCHEMA_VERSION = 5;
```

```ts
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
```

Note deliberately no `UNIQUE (session_id, path, symbol)` on `file_claim`:
SQLite treats every `NULL` in a `UNIQUE` constraint as distinct from every
other `NULL`, so a constraint naming a nullable `symbol` column would let
repeated file-level claims (`symbol IS NULL`) for the same
`(session_id, path)` pile up instead of colliding. `FileClaimRepo.upsert`
below enforces uniqueness itself, by querying first, so the same NULL-vs-NULL
gap is closed in application logic instead.

- [ ] **Step 2: Write the failing repo tests**

```ts
// tests/db/file-claim-repo.test.ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { FileClaimRepo, type FileClaimRow } from '../../src/db/repositories/file-claim.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';

function seed(db: ReturnType<typeof openDatabase>) {
  const workspaces = new WorkspaceRepo(db);
  const sessions = new SessionRepo(db);
  workspaces.insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  sessions.insert({
    id: 's_1', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
    status: 'idle', worktreePath: '/tmp/w/a', branch: 'cw/a', createdAt: 'now',
    lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  return { workspaces, sessions };
}

function row(overrides: Partial<FileClaimRow> = {}): FileClaimRow {
  return {
    id: 'fc_1', sessionId: 's_1', workspaceId: 'ws_1', path: 'src/x.ts',
    symbol: 'foo', kind: 'function', headSha: 'abc123', bodyHash: 'hash1',
    firstSeen: 'now', lastSeen: 'now', ...overrides,
  };
}

describe('FileClaimRepo', () => {
  test('upsert inserts a new claim, then updates the same one in place', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new FileClaimRepo(db);

    repo.upsert(row());
    expect(repo.listBySession('s_1')).toHaveLength(1);

    repo.upsert(row({ bodyHash: 'hash2', lastSeen: 'later' }));
    const rows = repo.listBySession('s_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bodyHash).toBe('hash2');
  });

  test('upsert treats NULL symbol claims as distinct from symbol claims on the same path', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new FileClaimRepo(db);

    repo.upsert(row({ id: 'fc_1', symbol: null, kind: 'file' }));
    repo.upsert(row({ id: 'fc_1', symbol: null, kind: 'file', bodyHash: 'hash2' }));
    expect(repo.listBySession('s_1')).toHaveLength(1);

    repo.upsert(row({ id: 'fc_2', symbol: 'foo' }));
    expect(repo.listBySession('s_1')).toHaveLength(2);
  });

  test('deleteOne removes exactly the matching claim', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new FileClaimRepo(db);
    repo.upsert(row({ id: 'fc_1', symbol: 'foo' }));
    repo.upsert(row({ id: 'fc_2', symbol: 'bar' }));

    repo.deleteOne('s_1', 'src/x.ts', 'foo');
    const rows = repo.listBySession('s_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe('bar');
  });

  test('listByWorkspacePath finds claims from every session on that path', () => {
    const db = openDatabase(':memory:');
    const { sessions } = seed(db);
    sessions.insert({
      id: 's_2', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
      status: 'idle', worktreePath: '/tmp/w/b', branch: 'cw/b', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
    const repo = new FileClaimRepo(db);
    repo.upsert(row({ id: 'fc_1', sessionId: 's_1' }));
    repo.upsert(row({ id: 'fc_2', sessionId: 's_2', bodyHash: 'other' }));

    expect(repo.listByWorkspacePath('ws_1', 'src/x.ts')).toHaveLength(2);
  });

  test('deleteBySession clears every claim for that session', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new FileClaimRepo(db);
    repo.upsert(row({ id: 'fc_1', symbol: 'foo' }));
    repo.upsert(row({ id: 'fc_2', symbol: 'bar' }));
    repo.deleteBySession('s_1');
    expect(repo.listBySession('s_1')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test tests/db/file-claim-repo.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/repositories/file-claim.js'`

- [ ] **Step 4: Implement `FileClaimRepo`**

```ts
// src/db/repositories/file-claim.ts
import type { Database } from 'bun:sqlite';

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'const' | 'file';

export interface FileClaimRow {
  id: string;
  sessionId: string;
  workspaceId: string;
  path: string;
  symbol: string | null;
  kind: SymbolKind;
  headSha: string;
  bodyHash: string;
  firstSeen: string;
  lastSeen: string;
}

interface FileClaimRecord {
  id: string;
  session_id: string;
  workspace_id: string;
  path: string;
  symbol: string | null;
  kind: string;
  head_sha: string;
  body_hash: string;
  first_seen: string;
  last_seen: string;
}

const COLS =
  'id,session_id,workspace_id,path,symbol,kind,head_sha,body_hash,first_seen,last_seen';

function toRow(r: FileClaimRecord): FileClaimRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    workspaceId: r.workspace_id,
    path: r.path,
    symbol: r.symbol,
    kind: r.kind as SymbolKind,
    headSha: r.head_sha,
    bodyHash: r.body_hash,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
}

export class FileClaimRepo {
  constructor(private readonly db: Database) {}

  /**
   * `symbol IS NULL` cannot be matched with `symbol = ?` — SQL's `=` against
   * NULL is never true — so the file-level lookup (`symbol === null`) needs
   * its own branch rather than one `WHERE symbol = ?` for both cases.
   */
  findOne(sessionId: string, path: string, symbol: string | null): FileClaimRow | undefined {
    const clause = symbol === null ? 'symbol IS NULL' : 'symbol = ?';
    const args = symbol === null ? [sessionId, path] : [sessionId, path, symbol];
    const r = this.db
      .prepare(`SELECT ${COLS} FROM file_claim WHERE session_id=? AND path=? AND ${clause}`)
      .get(...args) as FileClaimRecord | null;
    return r ? toRow(r) : undefined;
  }

  /** Insert-or-replace-in-place, keyed on (sessionId, path, symbol) — see findOne for why this is not a SQL UNIQUE constraint. */
  upsert(row: FileClaimRow): void {
    const existing = this.findOne(row.sessionId, row.path, row.symbol);
    if (existing) {
      this.db
        .prepare('UPDATE file_claim SET kind=?, head_sha=?, body_hash=?, last_seen=? WHERE id=?')
        .run(row.kind, row.headSha, row.bodyHash, row.lastSeen, existing.id);
      return;
    }
    this.db
      .prepare(`INSERT INTO file_claim (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        row.id, row.sessionId, row.workspaceId, row.path, row.symbol, row.kind,
        row.headSha, row.bodyHash, row.firstSeen, row.lastSeen,
      );
  }

  deleteOne(sessionId: string, path: string, symbol: string | null): void {
    const clause = symbol === null ? 'symbol IS NULL' : 'symbol = ?';
    const args = symbol === null ? [sessionId, path] : [sessionId, path, symbol];
    this.db.prepare(`DELETE FROM file_claim WHERE session_id=? AND path=? AND ${clause}`).run(...args);
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM file_claim WHERE session_id=?').run(sessionId);
  }

  listBySession(sessionId: string): FileClaimRow[] {
    return (
      this.db.prepare(`SELECT ${COLS} FROM file_claim WHERE session_id=?`).all(sessionId) as FileClaimRecord[]
    ).map(toRow);
  }

  listByWorkspacePath(workspaceId: string, path: string): FileClaimRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM file_claim WHERE workspace_id=? AND path=?`)
        .all(workspaceId, path) as FileClaimRecord[]
    ).map(toRow);
  }
}
```

- [ ] **Step 5: Run to verify the `FileClaimRepo` tests pass**

Run: `bun test tests/db/file-claim-repo.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Write the failing `ContractRepo` test**

```ts
// tests/db/contract-repo.test.ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { ContractRepo, type ContractRow } from '../../src/db/repositories/contract.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';

function seed(db: ReturnType<typeof openDatabase>) {
  const workspaces = new WorkspaceRepo(db);
  const sessions = new SessionRepo(db);
  workspaces.insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  for (const id of ['s_1', 's_2']) {
    sessions.insert({
      id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
      status: 'idle', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
  }
}

function row(overrides: Partial<ContractRow> = {}): ContractRow {
  return {
    id: 'ct_1', workspaceId: 'ws_1', ownerSession: 's_1',
    symbolFqn: 'src/auth.ts#AuthService', sigHash: 'sig1',
    declaredAt: 'now', stableBy: null, ...overrides,
  };
}

describe('ContractRepo', () => {
  test('insert then findByFqn round-trips', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ContractRepo(db);
    repo.insert(row());
    expect(repo.findByFqn('ws_1', 'src/auth.ts#AuthService')?.sigHash).toBe('sig1');
  });

  test('updateSigHash changes only sigHash', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ContractRepo(db);
    repo.insert(row());
    repo.updateSigHash('ct_1', 'sig2');
    const found = repo.findByFqn('ws_1', 'src/auth.ts#AuthService');
    expect(found?.sigHash).toBe('sig2');
    expect(found?.declaredAt).toBe('now');
  });

  test('addSubscriber is idempotent and listSubscribers reflects it', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ContractRepo(db);
    repo.insert(row());
    repo.addSubscriber('ct_1', 's_2', 'now');
    repo.addSubscriber('ct_1', 's_2', 'later'); // re-subscribing must not duplicate or error
    expect(repo.listSubscribers('ct_1')).toEqual(['s_2']);
  });
});
```

- [ ] **Step 7: Run to verify it fails, then implement**

Run: `bun test tests/db/contract-repo.test.ts` — expect FAIL (module not found).

```ts
// src/db/repositories/contract.ts
import type { Database } from 'bun:sqlite';

export interface ContractRow {
  id: string;
  workspaceId: string;
  ownerSession: string;
  symbolFqn: string;
  sigHash: string;
  declaredAt: string;
  stableBy: string | null;
}

interface ContractRecord {
  id: string;
  workspace_id: string;
  owner_session: string;
  symbol_fqn: string;
  sig_hash: string;
  declared_at: string;
  stable_by: string | null;
}

const COLS = 'id,workspace_id,owner_session,symbol_fqn,sig_hash,declared_at,stable_by';

function toRow(r: ContractRecord): ContractRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    ownerSession: r.owner_session,
    symbolFqn: r.symbol_fqn,
    sigHash: r.sig_hash,
    declaredAt: r.declared_at,
    stableBy: r.stable_by,
  };
}

export class ContractRepo {
  constructor(private readonly db: Database) {}

  insert(row: ContractRow): void {
    this.db
      .prepare(`INSERT INTO contract (${COLS}) VALUES (?,?,?,?,?,?,?)`)
      .run(row.id, row.workspaceId, row.ownerSession, row.symbolFqn, row.sigHash, row.declaredAt, row.stableBy);
  }

  findByFqn(workspaceId: string, symbolFqn: string): ContractRow | undefined {
    const r = this.db
      .prepare(`SELECT ${COLS} FROM contract WHERE workspace_id=? AND symbol_fqn=?`)
      .get(workspaceId, symbolFqn) as ContractRecord | null;
    return r ? toRow(r) : undefined;
  }

  listByWorkspace(workspaceId: string): ContractRow[] {
    return (
      this.db.prepare(`SELECT ${COLS} FROM contract WHERE workspace_id=?`).all(workspaceId) as ContractRecord[]
    ).map(toRow);
  }

  updateSigHash(id: string, sigHash: string): void {
    this.db.prepare('UPDATE contract SET sig_hash=? WHERE id=?').run(sigHash, id);
  }

  addSubscriber(contractId: string, sessionId: string, subscribedAt: string): void {
    this.db
      .prepare(
        'INSERT INTO contract_sub (contract_id, session_id, subscribed_at) VALUES (?,?,?) ' +
          'ON CONFLICT (contract_id, session_id) DO NOTHING',
      )
      .run(contractId, sessionId, subscribedAt);
  }

  listSubscribers(contractId: string): string[] {
    return (
      this.db
        .prepare('SELECT session_id FROM contract_sub WHERE contract_id=?')
        .all(contractId) as { session_id: string }[]
    ).map((r) => r.session_id);
  }
}
```

- [ ] **Step 8: Run all repo tests**

Run: `bun test tests/db/file-claim-repo.test.ts tests/db/contract-repo.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/repositories/file-claim.ts src/db/repositories/contract.ts tests/db/file-claim-repo.test.ts tests/db/contract-repo.test.ts
git commit -m "feat(db): add file_claim and contract schema (migration 5)"
```

---

### Task 3: Symbol extraction core (`src/radar/`)

**Files:**
- Create: `src/radar/grammars.ts`
- Create: `src/radar/symbols.ts`
- Create: `src/radar/hash.ts`
- Test: `tests/radar/symbols.test.ts`
- Test: `tests/radar/hash.test.ts`

**Interfaces:**
- Produces: `languageForPath(path: string): SupportedLanguage | undefined`,
  `initGrammars(): Promise<void>` (idempotent, loads every grammar once),
  `extractSymbols(source: string, language: SupportedLanguage): SymbolRange[] | undefined`
  (`undefined` = the source has a syntax error, caller falls back to a
  file-level claim), `normalizeAndHash(source: string): string`. Task 4
  (indexer) is the only consumer.

- [ ] **Step 1: Write the failing hash test**

```ts
// tests/radar/hash.test.ts
import { describe, expect, test } from 'bun:test';
import { normalizeAndHash } from '../../src/radar/hash.js';

describe('normalizeAndHash', () => {
  test('two functions differing only in whitespace hash the same', () => {
    const a = 'function foo() {\n  return 1;\n}';
    const b = 'function foo() {\n    return 1;\n}\n\n';
    expect(normalizeAndHash(a)).toBe(normalizeAndHash(b));
  });

  test('two functions differing only in a // comment hash the same', () => {
    const a = 'function foo() {\n  return 1;\n}';
    const b = 'function foo() {\n  // note\n  return 1;\n}';
    expect(normalizeAndHash(a)).toBe(normalizeAndHash(b));
  });

  test('a real content change hashes differently', () => {
    const a = 'function foo() {\n  return 1;\n}';
    const b = 'function foo() {\n  return 2;\n}';
    expect(normalizeAndHash(a)).not.toBe(normalizeAndHash(b));
  });
});
```

- [ ] **Step 2: Verify it fails, then implement**

Run: `bun test tests/radar/hash.test.ts` — expect FAIL (module not found).

```ts
// src/radar/hash.ts
import { createHash } from 'node:crypto';

/**
 * Strips `//` and `#` line comments plus `/* *\/` block comments, then
 * collapses all whitespace runs to a single space, before hashing. This is a
 * DELIBERATELY blunt normalizer — it does not parse strings, so a `//` or
 * `#` appearing inside a string literal is stripped as if it started a
 * comment. That is an accepted over-normalization (see the M3 design doc
 * §4): the failure mode is treating a change as whitespace/comment-only when
 * it technically wasn't, which suppresses a claim rather than fabricating a
 * false collision — the safer direction to be wrong in for a noise-control
 * mechanism.
 */
export function normalizeAndHash(source: string): string {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const noLineComments = noBlockComments.replace(/(\/\/|#).*$/gm, '');
  const collapsed = noLineComments.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(collapsed).digest('hex');
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/radar/hash.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Write the grammar loader**

```ts
// src/radar/grammars.ts
import { readFileSync } from 'node:fs';
import { Language, Parser } from 'web-tree-sitter';
import tsWasm from '../../assets/grammars/tree-sitter-typescript.wasm' with { type: 'file' };
import tsxWasm from '../../assets/grammars/tree-sitter-tsx.wasm' with { type: 'file' };
import jsWasm from '../../assets/grammars/tree-sitter-javascript.wasm' with { type: 'file' };
import pyWasm from '../../assets/grammars/tree-sitter-python.wasm' with { type: 'file' };

export type SupportedLanguage = 'typescript' | 'tsx' | 'javascript' | 'python';

const ASSET_PATHS: Record<SupportedLanguage, string> = {
  typescript: tsWasm,
  tsx: tsxWasm,
  javascript: jsWasm,
  python: pyWasm,
};

const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
};

export function languageForPath(path: string): SupportedLanguage | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  return EXTENSION_TO_LANGUAGE[path.slice(dot).toLowerCase()];
}

let initPromise: Promise<void> | undefined;
const loaded = new Map<SupportedLanguage, Language>();

/**
 * Loads `Parser.init()` and every grammar exactly once, however many
 * sessions/files call this concurrently. `readFileSync` on the asset's
 * `with { type: 'file' }` path — rather than handing `Language.load` the
 * path string directly — is deliberate: under `bun build --compile` that
 * path is a virtual `/$bunfs/...` location, and `readFileSync` is verified
 * (via Bun's own patched `node:fs`) to resolve it; relying on
 * `Language.load`'s internal path handling to do the same is untested
 * surface this project does not control.
 */
export function initGrammars(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await Parser.init();
    for (const lang of Object.keys(ASSET_PATHS) as SupportedLanguage[]) {
      const bytes = readFileSync(ASSET_PATHS[lang]);
      loaded.set(lang, await Language.load(bytes));
    }
  })();
  return initPromise;
}

/** Must be called after `initGrammars()` has resolved. */
export function languageFor(lang: SupportedLanguage): Language {
  const found = loaded.get(lang);
  if (!found) throw new Error(`Grammar not loaded: ${lang}. Call initGrammars() first.`);
  return found;
}
```

- [ ] **Step 5: Write the failing symbol-extraction tests**

```ts
// tests/radar/symbols.test.ts
import { beforeAll, describe, expect, test } from 'bun:test';
import { initGrammars } from '../../src/radar/grammars.js';
import { extractSymbols } from '../../src/radar/symbols.js';

beforeAll(async () => {
  await initGrammars();
});

describe('extractSymbols — typescript', () => {
  test('extracts a plain top-level function', () => {
    const src = 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n';
    const symbols = extractSymbols(src, 'typescript');
    expect(symbols).toBeDefined();
    expect(symbols).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  test('extracts a class and its methods separately', () => {
    const src =
      'export class AuthService {\n' +
      '  login(user: string): boolean {\n    return true;\n  }\n' +
      '  logout(): void {}\n' +
      '}\n';
    const symbols = extractSymbols(src, 'typescript');
    expect(symbols).toBeDefined();
    const names = symbols?.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('class:AuthService');
    expect(names).toContain('method:login');
    expect(names).toContain('method:logout');
  });

  test('a generic function declaration is still extracted as one function symbol', () => {
    const src = 'export function identity<T>(x: T): T {\n  return x;\n}\n';
    const symbols = extractSymbols(src, 'typescript');
    expect(symbols).toContainEqual(expect.objectContaining({ name: 'identity', kind: 'function' }));
  });

  test('a nested function inside another function is NOT extracted as top-level', () => {
    const src = 'function outer() {\n  function inner() { return 1; }\n  return inner();\n}\n';
    const symbols = extractSymbols(src, 'typescript');
    const names = symbols?.map((s) => s.name);
    expect(names).toContain('outer');
    expect(names).not.toContain('inner');
  });

  test('an interface and a type alias are extracted', () => {
    const src = 'export interface Shape { area(): number }\nexport type Id = string;\n';
    const symbols = extractSymbols(src, 'typescript');
    const names = symbols?.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('interface:Shape');
    expect(names).toContain('type:Id');
  });

  test('a syntax-error file returns undefined so the caller can fall back to file-level', () => {
    const src = 'function broken( {{{ not valid typescript at all //// ';
    // Deliberately does not assert `undefined` for every malformed snippet —
    // tree-sitter is error-tolerant and can produce a partial tree for small
    // fragments. What matters operationally is that a file with a real,
    // unrecoverable syntax error degrades to file-level rather than
    // crashing; this fixture is chosen to trigger that path.
    const symbols = extractSymbols(src, 'typescript');
    expect(symbols).toBeUndefined();
  });
});

describe('extractSymbols — python', () => {
  test('extracts a function and a class with a nested method', () => {
    const src = 'def greet(name):\n    return f"hi {name}"\n\n\nclass AuthService:\n    def login(self):\n        return True\n';
    const symbols = extractSymbols(src, 'python');
    const names = symbols?.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('function:greet');
    expect(names).toContain('class:AuthService');
    expect(names).toContain('method:login');
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `bun test tests/radar/symbols.test.ts` — expect FAIL (module not found).

- [ ] **Step 7: Implement `extractSymbols`**

```ts
// src/radar/symbols.ts
import type { Node } from 'web-tree-sitter';
import { Parser } from 'web-tree-sitter';
import { languageFor, type SupportedLanguage } from './grammars.js';

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'const';

export interface SymbolRange {
  name: string;
  kind: SymbolKind;
  startByte: number;
  endByte: number;
}

/** Unwraps `export`/`export default` so the wrapped declaration is what gets classified. */
function unwrapExport(node: Node): Node {
  if (node.type === 'export_statement') {
    return node.childForFieldName('declaration') ?? node;
  }
  return node;
}

function tsTopLevelSymbol(node: Node): SymbolRange | undefined {
  const inner = unwrapExport(node);
  switch (inner.type) {
    case 'function_declaration': {
      const name = inner.childForFieldName('name')?.text;
      return name ? { name, kind: 'function', startByte: node.startIndex, endByte: node.endIndex } : undefined;
    }
    case 'interface_declaration': {
      const name = inner.childForFieldName('name')?.text;
      return name ? { name, kind: 'interface', startByte: node.startIndex, endByte: node.endIndex } : undefined;
    }
    case 'type_alias_declaration': {
      const name = inner.childForFieldName('name')?.text;
      return name ? { name, kind: 'type', startByte: node.startIndex, endByte: node.endIndex } : undefined;
    }
    case 'lexical_declaration': {
      // `const x = ...` — take the first declarator's name; multi-declarator
      // top-level consts are rare enough that only the first is claimed.
      const declarator = inner.namedChild(0);
      const name = declarator?.childForFieldName('name')?.text;
      return name ? { name, kind: 'const', startByte: node.startIndex, endByte: node.endIndex } : undefined;
    }
    default:
      return undefined;
  }
}

function tsClassMethods(classNode: Node): SymbolRange[] {
  const body = classNode.childForFieldName('body');
  if (!body) return [];
  const out: SymbolRange[] = [];
  for (const child of body.namedChildren) {
    if (!child || child.type !== 'method_definition') continue;
    const name = child.childForFieldName('name')?.text;
    if (name) out.push({ name, kind: 'method', startByte: child.startIndex, endByte: child.endIndex });
  }
  return out;
}

function extractTsLike(root: Node): SymbolRange[] {
  const out: SymbolRange[] = [];
  for (const child of root.namedChildren) {
    if (!child) continue;
    const symbol = tsTopLevelSymbol(child);
    if (symbol) out.push(symbol);
    const inner = unwrapExport(child);
    if (inner.type === 'class_declaration') {
      const name = inner.childForFieldName('name')?.text;
      if (name) out.push({ name, kind: 'class', startByte: child.startIndex, endByte: child.endIndex });
      out.push(...tsClassMethods(inner));
    }
  }
  return out;
}

function pyClassMethods(classNode: Node): SymbolRange[] {
  const body = classNode.childForFieldName('body');
  if (!body) return [];
  const out: SymbolRange[] = [];
  for (const child of body.namedChildren) {
    if (!child || child.type !== 'function_definition') continue;
    const name = child.childForFieldName('name')?.text;
    if (name) out.push({ name, kind: 'method', startByte: child.startIndex, endByte: child.endIndex });
  }
  return out;
}

function extractPython(root: Node): SymbolRange[] {
  const out: SymbolRange[] = [];
  for (const child of root.namedChildren) {
    if (!child) continue;
    if (child.type === 'function_definition') {
      const name = child.childForFieldName('name')?.text;
      if (name) out.push({ name, kind: 'function', startByte: child.startIndex, endByte: child.endIndex });
    } else if (child.type === 'class_definition') {
      const name = child.childForFieldName('name')?.text;
      if (name) out.push({ name, kind: 'class', startByte: child.startIndex, endByte: child.endIndex });
      out.push(...pyClassMethods(child));
    }
  }
  return out;
}

/**
 * Returns `undefined` — never throws, never returns an empty array meaning
 * something different from "genuinely no top-level symbols" — when the
 * source's root node contains an unrecoverable syntax error. The caller
 * (Task 4's indexer) treats `undefined` as "fall back to a file-level
 * claim", per the M3 design doc §4.
 */
export function extractSymbols(source: string, language: SupportedLanguage): SymbolRange[] | undefined {
  const parser = new Parser();
  try {
    parser.setLanguage(languageFor(language));
    const tree = parser.parse(source);
    if (!tree) return undefined;
    const root = tree.rootNode;
    if (root.hasError) return undefined;
    return language === 'python' ? extractPython(root) : extractTsLike(root);
  } finally {
    parser.delete();
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `bun test tests/radar/symbols.test.ts`
Expected: PASS (7 tests). If a specific node-type assumption above doesn't
match the actual grammar's output (tree-sitter node names are generally
stable, but this is the plan's one genuinely empirical assumption), print
`tree.rootNode.toString()` for the failing fixture inside a scratch script to
see the real tree shape and adjust the `switch`/`if` branches in
`tsTopLevelSymbol`/`extractPython` accordingly — the fixtures and expected
symbol lists are the actual spec here, not the specific node-type strings.

- [ ] **Step 9: Commit**

```bash
git add src/radar/grammars.ts src/radar/symbols.ts src/radar/hash.ts tests/radar/symbols.test.ts tests/radar/hash.test.ts
git commit -m "feat(radar): symbol extraction core over web-tree-sitter"
```

---

### Task 4: Radar indexer — git diff to `file_claim` rows

**Files:**
- Create: `src/radar/indexer.ts`
- Test: `tests/radar/indexer.test.ts`

**Interfaces:**
- Consumes: `FileClaimRepo` (Task 2), `languageForPath`/`initGrammars`/`extractSymbols` (Task 3), `normalizeAndHash` (Task 3).
- Produces: `class RadarIndexer { reindexSession(session: { id: string; workspaceId: string; worktreePath: string; forkPoint: string }): Promise<void> }`
  — Task 5 (watcher) is the only caller, on its debounce tick. Also exported:
  `diffChangedFiles(worktreePath: string, forkPoint: string): Promise<string[]>`
  for direct testing of the git seam.

- [ ] **Step 1: Write the failing indexer test (real git fixture)**

```ts
// tests/radar/indexer.test.ts
import { beforeAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { RadarIndexer } from '../../src/radar/indexer.js';
import { initGrammars } from '../../src/radar/grammars.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';

beforeAll(async () => {
  await initGrammars();
});

async function setup(fixture: GitFixture) {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  new SessionRepo(db).insert({
    id: 's_1', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
    status: 'idle', worktreePath: fixture.root, branch: 'main', createdAt: 'now',
    lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  const claims = new FileClaimRepo(db);
  return { db, claims, indexer: new RadarIndexer(db) };
}

describe('RadarIndexer.reindexSession', () => {
  test('a genuinely changed function produces a claim', async () => {
    const fixture = await makeGitFixture();
    try {
      const forkPoint = (await commitFile(
        fixture.root, 'src/greet.ts', 'export function greet() {\n  return 1;\n}\n', 'base',
      ));
      const { claims, indexer } = await setup(fixture);

      await commitFile(fixture.root, 'src/greet.ts', 'export function greet() {\n  return 2;\n}\n', 'wip');

      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });

      const rows = claims.listBySession('s_1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.path).toBe('src/greet.ts');
      expect(rows[0]?.symbol).toBe('greet');
      expect(rows[0]?.kind).toBe('function');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a whitespace-only change produces no claim', async () => {
    const fixture = await makeGitFixture();
    try {
      const forkPoint = await commitFile(
        fixture.root, 'src/greet.ts', 'export function greet() {\n  return 1;\n}\n', 'base',
      );
      const { claims, indexer } = await setup(fixture);

      await commitFile(fixture.root, 'src/greet.ts', 'export function greet() {\n    return 1;\n}\n', 'wip');

      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });
      expect(claims.listBySession('s_1')).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('reverting to the merge-base content removes a previously written claim', async () => {
    const fixture = await makeGitFixture();
    try {
      const original = 'export function greet() {\n  return 1;\n}\n';
      const forkPoint = await commitFile(fixture.root, 'src/greet.ts', original, 'base');
      const { claims, indexer } = await setup(fixture);

      await commitFile(fixture.root, 'src/greet.ts', 'export function greet() {\n  return 2;\n}\n', 'wip');
      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });
      expect(claims.listBySession('s_1')).toHaveLength(1);

      await commitFile(fixture.root, 'src/greet.ts', original, 'revert');
      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });
      expect(claims.listBySession('s_1')).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('an unparseable/unsupported file gets a file-level claim', async () => {
    const fixture = await makeGitFixture();
    try {
      const forkPoint = await commitFile(fixture.root, 'README.md', '# a\n', 'base');
      const { claims, indexer } = await setup(fixture);

      await commitFile(fixture.root, 'README.md', '# a\n\nmore text\n', 'wip');
      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });

      const rows = claims.listBySession('s_1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.symbol).toBeNull();
      expect(rows[0]?.kind).toBe('file');
    } finally {
      await fixture.cleanup();
    }
  });

  test('advancing the fork point to include the change clears the now-stale claim', async () => {
    const fixture = await makeGitFixture();
    try {
      const forkPoint = await commitFile(
        fixture.root, 'src/greet.ts', 'export function greet() {\n  return 1;\n}\n', 'base',
      );
      const { claims, indexer } = await setup(fixture);

      const laterCommit = await commitFile(
        fixture.root, 'src/greet.ts', 'export function greet() {\n  return 2;\n}\n', 'wip',
      );
      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });
      expect(claims.listBySession('s_1')).toHaveLength(1);

      // Re-running with the fork point advanced to the commit that already
      // contains the change makes the diff against that new base empty —
      // the same reconciliation behavior a real "session committed and its
      // working tree is now clean relative to its own latest state" moment
      // would trigger, without needing M4's `cw land` to exist yet.
      await indexer.reindexSession({
        id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint: laterCommit,
      });
      expect(claims.listBySession('s_1')).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/radar/indexer.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement the indexer**

```ts
// src/radar/indexer.ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { FileClaimRepo, type SymbolKind } from '../db/repositories/file-claim.js';
import { languageForPath, initGrammars } from './grammars.js';
import { extractSymbols } from './symbols.js';
import { normalizeAndHash } from './hash.js';

export interface IndexableSession {
  id: string;
  workspaceId: string;
  worktreePath: string;
  /** The commit this session's branch was created from — see WorktreeHandle.forkPoint. */
  forkPoint: string;
}

/** Files changed on disk (committed or not) relative to `forkPoint`, repo-relative paths. */
export async function diffChangedFiles(worktreePath: string, forkPoint: string): Promise<string[]> {
  const committed = execFileSync('git', ['diff', '--name-only', `${forkPoint}..HEAD`], {
    cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const uncommitted = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const all = new Set(
    [committed, uncommitted, untracked]
      .flatMap((out) => out.split('\n'))
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return [...all];
}

/** The file's content at `forkPoint`, or `undefined` if it did not exist there yet. */
function readAtForkPoint(worktreePath: string, forkPoint: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${forkPoint}:${path}`], {
      cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined; // new file — not present at the fork point
  }
}

export class RadarIndexer {
  private readonly claims: FileClaimRepo;

  constructor(db: Database) {
    this.claims = new FileClaimRepo(db);
  }

  /**
   * Re-derives every `file_claim` row for `session` from its current diff
   * against `forkPoint`. Idempotent and safe to call repeatedly — each run
   * fully reconciles this session's claims (upsert what's still divergent,
   * delete what reverted to the fork-point content), never accumulates.
   */
  async reindexSession(session: IndexableSession): Promise<void> {
    await initGrammars();
    const changed = await diffChangedFiles(session.worktreePath, session.forkPoint);
    const now = new Date().toISOString();
    const stillDivergent = new Set<string>(); // "path symbol-or-empty"

    for (const path of changed) {
      let current: string;
      try {
        current = readFileSync(join(session.worktreePath, path), 'utf8');
      } catch {
        continue; // deleted in the working tree — nothing to claim
      }
      const language = languageForPath(path);
      const before = readAtForkPoint(session.worktreePath, session.forkPoint, path);

      const symbols = language ? extractSymbols(current, language) : undefined;
      if (!language || symbols === undefined) {
        // Unsupported language, or a syntax error — one file-level claim.
        if (before === undefined || normalizeAndHash(before) !== normalizeAndHash(current)) {
          this.upsertClaim(session, path, null, 'file', current, now);
          stillDivergent.add(`${path} `);
        }
        continue;
      }

      const beforeSymbols = before !== undefined ? extractSymbols(before, language) : [];
      const beforeByName = new Map((beforeSymbols ?? []).map((s) => [s.name, s]));

      for (const sym of symbols) {
        const currentBody = current.slice(sym.startByte, sym.endByte);
        const priorRange = beforeByName.get(sym.name);
        const priorBody = priorRange !== undefined && before !== undefined
          ? before.slice(priorRange.startByte, priorRange.endByte)
          : undefined;

        if (priorBody !== undefined && normalizeAndHash(priorBody) === normalizeAndHash(currentBody)) {
          this.claims.deleteOne(session.id, path, sym.name);
          continue;
        }
        this.upsertClaim(session, path, sym.name, sym.kind, currentBody, now);
        stillDivergent.add(`${path} ${sym.name}`);
      }
    }

    // Anything this session previously claimed but that isn't in
    // `stillDivergent` any more (file no longer changed, or that symbol
    // reverted) is stale — drop it rather than let history accumulate.
    for (const existing of this.claims.listBySession(session.id)) {
      const key = `${existing.path} ${existing.symbol ?? ''}`;
      if (!stillDivergent.has(key)) {
        this.claims.deleteOne(session.id, existing.path, existing.symbol);
      }
    }
  }

  private upsertClaim(
    session: IndexableSession,
    path: string,
    symbol: string | null,
    kind: SymbolKind,
    body: string,
    now: string,
  ): void {
    const existing = this.claims.findOne(session.id, path, symbol);
    this.claims.upsert({
      id: existing?.id ?? newId('fc' as never), // see note below on the id prefix
      sessionId: session.id,
      workspaceId: session.workspaceId,
      path,
      symbol,
      kind,
      headSha: session.forkPoint,
      bodyHash: normalizeAndHash(body),
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    });
  }
}
```

`newId` only accepts the prefixes already listed in `src/core/ids.ts`
(`'ws' | 's' | 'ev' | 'msg' | 'lease' | 'ctx'`). Before Step 3 compiles,
widen that union to add `'fc'` (file claim) and `'ct'` (contract, needed by
Task 8) in the same file:

```ts
// src/core/ids.ts — widen the existing union
type IdPrefix = 'ws' | 's' | 'ev' | 'msg' | 'lease' | 'ctx' | 'fc' | 'ct';
```

and drop the `as never` cast above once that widening is in place —
`newId('fc')` should type-check directly.

- [ ] **Step 4: Run to verify tests pass**

Run: `bun test tests/radar/indexer.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors (confirms the `IdPrefix` widening compiles everywhere `newId` is already called).

- [ ] **Step 6: Commit**

```bash
git add src/radar/indexer.ts src/core/ids.ts tests/radar/indexer.test.ts
git commit -m "feat(radar): git-diff-driven claim indexer"
```

---

### Task 5: Debounced watcher wiring and session lifecycle

**Files:**
- Create: `src/radar/watch-debounce.ts`
- Create: `src/daemon/watcher.ts`
- Modify: `src/daemon/methods.ts`
- Test: `tests/radar/watch-debounce.test.ts`

**Interfaces:**
- Consumes: `RadarIndexer.reindexSession` (Task 4).
- Produces: `class RadarWatcherRegistry { start(session): void; stop(sessionId): void; stopAll(): Promise<void> }`,
  called from `buildMethods`' `start`/`session.stop`/`session.kill` paths and
  `daemon.shutdown` (mirrors the existing `mcpServers` map lifecycle exactly).

- [ ] **Step 1: Write the failing debounce test**

Per this plan's Global Constraint on sandboxed `fs.watch` unreliability, this
tests the debounce TIMER in isolation — manually calling `trigger()`
simulates what a real filesystem event would do, so the test never depends
on an actual OS notification arriving.

```ts
// tests/radar/watch-debounce.test.ts
import { describe, expect, test } from 'bun:test';
import { createDebouncer } from '../../src/radar/watch-debounce.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createDebouncer', () => {
  test('a single trigger fires once after the delay', async () => {
    let calls = 0;
    const debouncer = createDebouncer(() => { calls += 1; }, 20);
    debouncer.trigger();
    await sleep(10);
    expect(calls).toBe(0); // not yet — still inside the debounce window
    await sleep(20);
    expect(calls).toBe(1);
  });

  test('rapid triggers inside the window collapse to one call', async () => {
    let calls = 0;
    const debouncer = createDebouncer(() => { calls += 1; }, 20);
    debouncer.trigger();
    await sleep(5);
    debouncer.trigger();
    await sleep(5);
    debouncer.trigger();
    await sleep(30);
    expect(calls).toBe(1);
  });

  test('stop() cancels a pending call', async () => {
    let calls = 0;
    const debouncer = createDebouncer(() => { calls += 1; }, 20);
    debouncer.trigger();
    debouncer.stop();
    await sleep(30);
    expect(calls).toBe(0);
  });

  test('triggers after the window fire again independently', async () => {
    let calls = 0;
    const debouncer = createDebouncer(() => { calls += 1; }, 15);
    debouncer.trigger();
    await sleep(25);
    expect(calls).toBe(1);
    debouncer.trigger();
    await sleep(25);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Verify failure, then implement**

Run: `bun test tests/radar/watch-debounce.test.ts` — expect FAIL (module not found).

```ts
// src/radar/watch-debounce.ts

export interface Debouncer {
  trigger(): void;
  stop(): void;
}

/** Collapses a burst of `trigger()` calls into one `onFire()`, `delayMs` after the last one. */
export function createDebouncer(onFire: () => void, delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    trigger(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onFire();
      }, delayMs);
    },
    stop(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/radar/watch-debounce.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Write the thin `fs.watch` wiring (no dedicated test — see rationale)**

```ts
// src/daemon/watcher.ts
import type { Database } from 'bun:sqlite';
import { watch, type FSWatcher } from 'node:fs';
import { RadarIndexer, type IndexableSession } from '../radar/indexer.js';
import { createDebouncer } from '../radar/watch-debounce.js';

const DEBOUNCE_MS = 500;

/**
 * One `fs.watch` per session with its own worktree, debounced into the
 * indexer. Deliberately NOT unit-tested against a live filesystem event —
 * see this plan's Global Constraints: sandboxed dev/CI shells do not
 * reliably deliver `fs.watch` notifications even though the underlying
 * writes succeed, which would make such a test flaky for a reason that has
 * nothing to do with this code's correctness. `RadarWatcherRegistry`'s real
 * logic (Task 4's indexer, this file's debounce timer) is tested directly;
 * this class is the last few lines of OS wiring around both.
 *
 * NOTE: Task 8 replaces this class with a version that also takes `bus` and
 * `contracts` constructor arguments and notifies collisions/contract
 * changes after each reindex — this Task-5 version is this file's starting
 * point, not its final shape.
 */
export class RadarWatcherRegistry {
  private readonly indexer: RadarIndexer;
  private readonly watchers = new Map<string, { fsWatcher: FSWatcher; debouncer: ReturnType<typeof createDebouncer> }>();

  constructor(db: Database) {
    this.indexer = new RadarIndexer(db);
  }

  /** Only sessions with their OWN worktree are watched — a shared (`--no-worktree`) session has no fork point to diff against. */
  start(session: IndexableSession): void {
    this.stop(session.id);
    const debouncer = createDebouncer(() => {
      void this.indexer.reindexSession(session).catch((err: unknown) => {
        process.stderr.write(`crossweave: radar reindex failed for session ${session.id}: ${String(err)}\n`);
      });
    }, DEBOUNCE_MS);

    let fsWatcher: FSWatcher;
    try {
      fsWatcher = watch(session.worktreePath, { recursive: true }, () => debouncer.trigger());
    } catch (err) {
      // Best effort, exactly like the MCP server's bind failure: a session
      // whose worktree can't be watched still starts, just without Radar.
      process.stderr.write(`crossweave: could not watch worktree for session ${session.id}: ${String(err)}\n`);
      return;
    }
    this.watchers.set(session.id, { fsWatcher, debouncer });
  }

  stop(sessionId: string): void {
    const entry = this.watchers.get(sessionId);
    if (!entry) return;
    entry.debouncer.stop();
    entry.fsWatcher.close();
    this.watchers.delete(sessionId);
  }

  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.stop(id);
  }
}
```

- [ ] **Step 5: Wire into `buildMethods`**

In `src/daemon/methods.ts`, alongside the existing `ledger`/`bus`/`contextStore` construction:

```ts
import { RadarWatcherRegistry } from './watcher.js';
// ...
const radarWatchers = new RadarWatcherRegistry(db);
```

Inside `start(p)`, after the MCP server's `try`/`catch` block, watching
begins only once the session is actually running and only for sessions with
their own worktree — a `forkPoint` only exists then, recorded exactly once at
session creation per `src/domain/session.ts`. `EventLedger` has no public
method to read a session's fork point today (`history` is private) — add
one:

```ts
  // In src/domain/ledger.ts, EventLedger — a thin public wrapper around the
  // existing private `history()`, needed by the watcher to know where a
  // session's diff should start from.
  forkPointFor(sessionId: string): string | undefined {
    return this.history(sessionId).forkPoint;
  }
```

Then in `methods.ts`'s `start(p)`:

```ts
      if (row.worktreePath !== null && row.worktreePath !== projectRoot) {
        const forkPoint = ledger.forkPointFor(row.id);
        if (forkPoint !== undefined) {
          radarWatchers.start({
            id: row.id, workspaceId: row.workspaceId,
            worktreePath: row.worktreePath, forkPoint,
          });
        }
      }
```

And stop it wherever a session stops being live — `session.stop`,
`session.kill`'s `onKill` path (via the same `runtime.stop` callback already
used for lease/MCP cleanup), and `daemon.shutdown`:

```ts
  const runtime = new SessionRuntime((sessionId) => {
    sessions.clearRunning(sessionId);
    leaseManager.release(sessionId);
    radarWatchers.stop(sessionId);
    const handle = mcpServers.get(sessionId);
    if (handle !== undefined) void closeMcpServer(sessionId, handle);
  });
```

```ts
    'session.stop': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      const handle = mcpServers.get(row.id);
      radarWatchers.stop(row.id);
      await runtime.stop(row.id);
      leaseManager.release(row.id);
      if (handle !== undefined) await closeMcpServer(row.id, handle);
      return { ok: true };
    },
```

```ts
    'daemon.shutdown': async () => {
      radarWatchers.stopAll();
      await runtime.stopAll();
      for (const [sessionId, handle] of [...mcpServers]) void closeMcpServer(sessionId, handle);
      await Promise.all([...closingMcpServers]);
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },
```

- [ ] **Step 6: Typecheck and run the full suite**

Run: `bun run typecheck && bun test`
Expected: 0 type errors, all tests pass (the watcher itself has no dedicated
test file — its behavior is exercised through the already-passing debounce
and indexer tests it composes, per Step 4's rationale).

- [ ] **Step 7: Commit**

```bash
git add src/radar/watch-debounce.ts src/daemon/watcher.ts src/daemon/methods.ts src/domain/ledger.ts tests/radar/watch-debounce.test.ts
git commit -m "feat(radar): debounced per-session file watcher wired into session lifecycle"
```

---

### Task 6: Collision detection — `radar.check`

**Files:**
- Create: `src/radar/collisions.ts`
- Modify: `src/daemon/methods.ts`
- Test: `tests/radar/collisions.test.ts`
- Test: `tests/daemon/methods-radar.test.ts`

**Interfaces:**
- Consumes: `FileClaimRepo` (Task 2).
- Produces: `checkCollisions(claims: FileClaimRepo, opts: { workspaceId, sessionId, path, symbol? }): Collision[]`,
  and the `radar.check` RPC method — Task 7 (noise-controlled hook delivery)
  and Task 8 (`cw_check` MCP tool) both call the RPC method, not this
  function directly (they run in different processes from the daemon).

- [ ] **Step 1: Write the failing collision-detection unit test**

```ts
// tests/radar/collisions.test.ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo, type FileClaimRow } from '../../src/db/repositories/file-claim.js';
import { checkCollisions } from '../../src/radar/collisions.js';

function seed(db: ReturnType<typeof openDatabase>) {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  const sessions = new SessionRepo(db);
  for (const id of ['s_1', 's_2', 's_3']) {
    sessions.insert({
      id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
  }
}

function claim(overrides: Partial<FileClaimRow>): FileClaimRow {
  return {
    id: overrides.id ?? 'fc_x', sessionId: 's_1', workspaceId: 'ws_1', path: 'src/x.ts',
    symbol: 'foo', kind: 'function', headSha: 'sha', bodyHash: 'h1',
    firstSeen: 'now', lastSeen: 'now', ...overrides,
  };
}

describe('checkCollisions', () => {
  test('two sessions with divergent claims on the same symbol collide', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert(claim({ id: 'fc_1', sessionId: 's_1', bodyHash: 'h1' }));
    claims.upsert(claim({ id: 'fc_2', sessionId: 's_2', bodyHash: 'h2' }));

    const found = checkCollisions(claims, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' });
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe('s_2');
  });

  test('claims on different symbols in the same file do not collide', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert(claim({ id: 'fc_1', sessionId: 's_1', symbol: 'foo', bodyHash: 'h1' }));
    claims.upsert(claim({ id: 'fc_2', sessionId: 's_2', symbol: 'bar', bodyHash: 'h2' }));

    expect(checkCollisions(claims, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' })).toHaveLength(0);
  });

  test('a file-level query (no symbol) matches a symbol-level claim from another session on the same path', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert(claim({ id: 'fc_1', sessionId: 's_1', symbol: null, kind: 'file', bodyHash: 'h1' }));
    claims.upsert(claim({ id: 'fc_2', sessionId: 's_2', symbol: 'foo', bodyHash: 'h2' }));

    const found = checkCollisions(claims, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts' });
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe('s_2');
  });

  test('the querying session itself is never returned as a collision', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert(claim({ id: 'fc_1', sessionId: 's_1', bodyHash: 'h1' }));

    expect(checkCollisions(claims, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' })).toHaveLength(0);
  });

  test('a third, unrelated session on a different path never appears', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert(claim({ id: 'fc_1', sessionId: 's_1', bodyHash: 'h1' }));
    claims.upsert(claim({ id: 'fc_2', sessionId: 's_3', path: 'src/y.ts', symbol: 'baz', bodyHash: 'h3' }));

    const found = checkCollisions(claims, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' });
    expect(found.map((c) => c.sessionId)).not.toContain('s_3');
  });
});
```

- [ ] **Step 2: Verify failure, then implement**

Run: `bun test tests/radar/collisions.test.ts` — expect FAIL (module not found).

```ts
// src/radar/collisions.ts
import type { FileClaimRepo } from '../db/repositories/file-claim.js';
import type { SymbolKind } from '../db/repositories/file-claim.js';

export interface Collision {
  sessionId: string;
  path: string;
  symbol: string | null;
  kind: SymbolKind;
}

export interface CheckOpts {
  workspaceId: string;
  sessionId: string;
  path: string;
  symbol?: string;
}

/**
 * Every OTHER session's claim on `path` that genuinely diverges from the
 * caller's own view of it. A file-level query (`symbol` omitted) matches any
 * claim on that path regardless of the other session's granularity — an
 * agent about to touch a whole file deserves to know about a symbol-scoped
 * claim inside it, not just an exact file-level match.
 */
export function checkCollisions(claims: FileClaimRepo, opts: CheckOpts): Collision[] {
  const own = claims.findOne(opts.sessionId, opts.path, opts.symbol ?? null);
  const others = claims
    .listByWorkspacePath(opts.workspaceId, opts.path)
    .filter((c) => c.sessionId !== opts.sessionId)
    .filter((c) => opts.symbol === undefined || c.symbol === null || c.symbol === opts.symbol);

  return others
    .filter((c) => own === undefined || c.bodyHash !== own.bodyHash)
    .map((c) => ({ sessionId: c.sessionId, path: c.path, symbol: c.symbol, kind: c.kind }));
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/radar/collisions.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 4: Wire the `radar.check` RPC method**

In `src/daemon/methods.ts`:

```ts
import { FileClaimRepo } from '../db/repositories/file-claim.js';
import { checkCollisions } from '../radar/collisions.js';
// ...
const fileClaims = new FileClaimRepo(db);
```

```ts
    'radar.check': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const symbol = optionalStr(p, 'symbol');
      const collisions = checkCollisions(fileClaims, {
        workspaceId,
        sessionId: str(p, 'sessionId'),
        path: str(p, 'path'),
        symbol,
      });
      // checkCollisions stays pure (FileClaimRepo only, no session lookups —
      // see Task 6's unit tests). Session NAMES are a display concern, added
      // here where `sessions` is already in scope, for the one consumer that
      // needs a human-readable name: Task 9's hook advisory text.
      return {
        collisions: collisions.map((c) => ({
          ...c,
          sessionName: sessions.resolve(workspaceId, c.sessionId).name,
        })),
      };
    },
```

- [ ] **Step 5: Write the failing daemon-level integration test**

```ts
// tests/daemon/methods-radar.test.ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';

describe('radar.check RPC', () => {
  test('reports a collision written directly to file_claim', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    for (const id of ['s_1', 's_2']) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
    }
    new FileClaimRepo(db).upsert({
      id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });

    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { collisions: unknown[] };

    expect(result.collisions).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun test tests/daemon/methods-radar.test.ts`
Expected: PASS (1 test)

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all green.

- [ ] **Step 8: Commit**

```bash
git add src/radar/collisions.ts src/daemon/methods.ts tests/radar/collisions.test.ts tests/daemon/methods-radar.test.ts
git commit -m "feat(radar): collision detection and the radar.check RPC method"
```

---

### Task 7: Noise control — rate limit, coalescing, reference check, retroactive notify

**Files:**
- Create: `src/radar/noise.ts`
- Create: `src/radar/retro-notify.ts`
- Test: `tests/radar/noise.test.ts`
- Test: `tests/radar/retro-notify.test.ts`

**Interfaces:**
- Produces: `class NotificationGate { shouldNotify(sessionId: string, path: string, symbol: string | null): boolean }`
  (rate limit + coalescing, injectable clock), `references(worktreePath: string, touchedFiles: string[], symbolName: string): boolean`
  (ripgrep-based), and `notifyCollisions(claims: FileClaimRepo, bus: MessageBus, gate: NotificationGate, opts: { workspaceId, sessionId }): void`
  — the retroactive delivery path from the M3 design doc §5 for sessions
  with no `PreToolUse` hook to ask `radar.check` for them. Task 9
  (`cw radar-hook`) consumes `NotificationGate`/`references` directly. Task 8
  wires `notifyCollisions` into the watcher's debounce callback, once
  `ContractService` (which the same callback also needs) exists.
  `radar.check` and `cw_check` (Task 6/8) never call any of this, per the
  scope decision below.

**Two scope decisions made while implementing this task, not left to the
implementer's discretion:**

1. The M3 design doc's §5/§6 separates "detection" (always-accurate) from
   "noise control" (governs proactive pushes) without fully spelling out
   which delivery paths get filtered. This plan resolves it as:
   `radar.check` and `cw_check` (an agent's own explicit query) always
   return the true, current, unfiltered collision set — an agent that asked
   deserves a straight answer. Rate-limit/coalesce noise control applies
   ONLY to unprompted notifications: the hook's automatic `additionalContext`
   injection on every `Edit`/`Write`, and the watcher's retroactive
   `MessageBus` notice for sessions with no hook. This keeps "am I colliding
   right now" always honest while still preventing every keystroke-equivalent
   tool call from re-showing the same advisory note.

2. **Reference scoping (`references()`) is implemented and unit-tested in
   this task but deliberately NOT wired into `notifyCollisions` or the hook
   path.** Doing so correctly needs the RECIPIENT session's live worktree
   contents to search (per the design doc §5: "is the session editing S
   itself, or does S's name appear in that session's own touched files") —
   `notifyCollisions`'s tests operate purely against in-memory DB rows with
   no real worktree on disk, matching this codebase's existing style for
   domain-logic tests (`bus.test.ts`, `context-store.test.ts`), and
   retrofitting a live-filesystem dependency into that test shape belongs in
   its own reviewed task, not folded in here under this task's time budget.
   The rate limit + coalescing above are what actually bound notification
   volume for M3; reference scoping is a real gap worth naming in the M3
   known-limitations doc as a ready-to-wire follow-up (the function exists,
   is tested, and its call site is exactly `notifyCollisions`'s inner loop —
   see this task's Step 5).

- [ ] **Step 1: Write the failing rate-limit/coalescing tests**

```ts
// tests/radar/noise.test.ts
import { describe, expect, test } from 'bun:test';
import { NotificationGate, references } from '../../src/radar/noise.js';

describe('NotificationGate', () => {
  test('allows the first notification for a given session/path/symbol', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'foo')).toBe(true);
  });

  test('coalesces repeat notifications for the SAME symbol within the window', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'foo')).toBe(true);
    now += 1000;
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'foo')).toBe(false);
  });

  test('a different symbol is not coalesced by an unrelated one', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'foo')).toBe(true);
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'bar')).toBe(true);
  });

  test('rate-limits to 6 distinct notifications per 10 minutes per session', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    for (let i = 0; i < 6; i += 1) {
      expect(gate.shouldNotify('s_1', 'src/x.ts', `sym${i}`)).toBe(true);
      now += 1; // distinct enough not to coalesce
    }
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'sym6')).toBe(false);
  });

  test('the rate limit resets once entries age out of the 10-minute window', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    for (let i = 0; i < 6; i += 1) {
      gate.shouldNotify('s_1', 'src/x.ts', `sym${i}`);
      now += 1;
    }
    now += 10 * 60 * 1000 + 1;
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'sym6')).toBe(true);
  });

  test('rate limits are tracked per session, not globally', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    for (let i = 0; i < 6; i += 1) {
      gate.shouldNotify('s_1', 'src/x.ts', `sym${i}`);
      now += 1;
    }
    expect(gate.shouldNotify('s_2', 'src/x.ts', 'sym0')).toBe(true);
  });
});

describe('references', () => {
  test('finds the symbol name inside a touched file', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'cw-ref-'));
    try {
      await writeFile(join(dir, 'consumer.ts'), 'import { AuthService } from "./auth";\nnew AuthService();\n');
      expect(references(dir, ['consumer.ts'], 'AuthService')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns false when the symbol name does not appear anywhere', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'cw-ref-'));
    try {
      await writeFile(join(dir, 'consumer.ts'), 'export const unrelated = 1;\n');
      expect(references(dir, ['consumer.ts'], 'AuthService')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns false for an empty touched-files list without shelling out', () => {
    expect(references('/does/not/matter', [], 'AuthService')).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure, then implement**

Run: `bun test tests/radar/noise.test.ts` — expect FAIL (module not found).

```ts
// src/radar/noise.ts
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 6;

/**
 * Governs UNPROMPTED notifications only (hook advisories, retroactive inbox
 * notices) — never `radar.check`/`cw_check`'s own direct answer. See this
 * task's header note for the full reasoning.
 *
 * In-memory, per daemon process: resets on restart, consistent with this
 * project's existing posture on process-lifetime state (the daemon's
 * `starting` set, `LeaseManager`'s in-memory tracking before M1's disk
 * guard). `clock` is injectable so tests never depend on real elapsed time.
 */
export class NotificationGate {
  private readonly sent = new Map<string, number[]>(); // sessionId -> timestamps
  private readonly coalesced = new Map<string, number>(); // `${sessionId}\0${path}\0${symbol}` -> last-sent ts

  constructor(private readonly clock: () => number = () => Date.now()) {}

  shouldNotify(sessionId: string, path: string, symbol: string | null): boolean {
    const now = this.clock();
    const coalesceKey = `${sessionId} ${path} ${symbol ?? ''}`;
    if (this.coalesced.has(coalesceKey)) return false;

    const timestamps = (this.sent.get(sessionId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (timestamps.length >= MAX_PER_WINDOW) {
      this.sent.set(sessionId, timestamps);
      return false;
    }

    timestamps.push(now);
    this.sent.set(sessionId, timestamps);
    this.coalesced.set(coalesceKey, now);
    return true;
  }
}

/**
 * Cheap approximation of "does this session care about `symbolName`": a
 * ripgrep search for the identifier across the session's own touched files.
 * Deliberately not a real import graph (see the M3 design doc §5/§9) —
 * tuned to over-notify rather than silently miss. Returns `false` (not an
 * error) if `rg` is unavailable, so a session without ripgrep on PATH simply
 * never gets reference-scoped notifications rather than crashing.
 */
export function references(worktreePath: string, touchedFiles: string[], symbolName: string): boolean {
  if (touchedFiles.length === 0) return false;
  try {
    execFileSync(
      'rg', ['-l', '--fixed-strings', symbolName, ...touchedFiles.map((f) => join(worktreePath, f))],
      { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return true; // exit 0 — at least one match
  } catch (err) {
    // exit 1 = no match (not an error condition); anything else (rg missing, etc.) also degrades to false.
    return false;
  }
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/radar/noise.test.ts`
Expected: PASS (9 tests). The two tests that shell out to `rg` require
`ripgrep` on PATH; if it is not installed in this environment, install it
first (`brew install ripgrep` / `apt-get install ripgrep`) — `references()`
degrading to `false` without it is the correct PRODUCTION behavior (see its
doc comment), but the test's job is to confirm the TRUE-finding path also
works, which needs a real `rg` binary.

- [ ] **Step 4: Write the failing retroactive-notify test**

```ts
// tests/radar/retro-notify.test.ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { MessageBus } from '../../src/domain/bus.js';
import { SessionManager } from '../../src/domain/session.js';
import { NotificationGate } from '../../src/radar/noise.js';
import { notifyCollisions } from '../../src/radar/retro-notify.js';

function seed(db: ReturnType<typeof openDatabase>) {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  const sessions = new SessionRepo(db);
  for (const id of ['s_1', 's_2']) {
    sessions.insert({
      id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
  }
}

describe('notifyCollisions', () => {
  test('a session with a divergent claim gets a system inbox message', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert({
      id: 'fc_1', sessionId: 's_1', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h1', firstSeen: 'now', lastSeen: 'now',
    });
    claims.upsert({
      id: 'fc_2', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });
    const bus = new MessageBus(db, new SessionManager(db));

    notifyCollisions(claims, bus, new NotificationGate(), { workspaceId: 'ws_1', sessionId: 's_1' });

    const inbox = bus.inbox('ws_1', 's_2');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.trust).toBe('system');
    expect(inbox[0]?.body).toContain('src/x.ts');
  });

  test('the rate-limit gate suppresses a repeat call for the same collision', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert({
      id: 'fc_1', sessionId: 's_1', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h1', firstSeen: 'now', lastSeen: 'now',
    });
    claims.upsert({
      id: 'fc_2', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });
    const bus = new MessageBus(db, new SessionManager(db));
    const gate = new NotificationGate();

    notifyCollisions(claims, bus, gate, { workspaceId: 'ws_1', sessionId: 's_1' });
    notifyCollisions(claims, bus, gate, { workspaceId: 'ws_1', sessionId: 's_1' });

    expect(bus.inbox('ws_1', 's_2')).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Verify failure, then implement**

Run: `bun test tests/radar/retro-notify.test.ts` — expect FAIL (module not found).

```ts
// src/radar/retro-notify.ts
import type { FileClaimRepo } from '../db/repositories/file-claim.js';
import type { MessageBus } from '../domain/bus.js';
import { checkCollisions } from './collisions.js';
import type { NotificationGate } from './noise.js';

export interface RetroNotifyOpts {
  workspaceId: string;
  sessionId: string;
}

/**
 * After a reindex, tells every OTHER session with a genuinely divergent
 * claim about this session's changes — the "everyone else" delivery path
 * from the M3 design doc §5, reaching sessions with no `PreToolUse` hook to
 * ask `radar.check` on their behalf. Rate-limited/coalesced through `gate`,
 * exactly like the hook's own advisory (Task 9) — see Task 7's noise-control
 * scope note in this plan for why this path is filtered but
 * `radar.check`/`cw_check` are not.
 */
export function notifyCollisions(
  claims: FileClaimRepo,
  bus: MessageBus,
  gate: NotificationGate,
  opts: RetroNotifyOpts,
): void {
  for (const claim of claims.listBySession(opts.sessionId)) {
    const collisions = checkCollisions(claims, {
      workspaceId: opts.workspaceId,
      sessionId: opts.sessionId,
      path: claim.path,
      symbol: claim.symbol ?? undefined,
    });
    for (const collision of collisions) {
      if (!gate.shouldNotify(collision.sessionId, collision.path, collision.symbol)) continue;
      bus.send({
        workspaceId: opts.workspaceId,
        fromSession: opts.sessionId,
        toSession: collision.sessionId,
        trust: 'system',
        body:
          `crossweave Radar: session ${opts.sessionId} also has divergent changes to ${collision.path}` +
          `${collision.symbol ? ` (${collision.symbol})` : ''}.`,
      });
    }
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun test tests/radar/retro-notify.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add src/radar/noise.ts src/radar/retro-notify.ts tests/radar/noise.test.ts tests/radar/retro-notify.test.ts
git commit -m "feat(radar): notification rate limiting, coalescing, reference scoping and retroactive collision notices"
```

---

### Task 8: `cw_check` / `cw_declare_contract` MCP tools and `contract.declare`

**Files:**
- Create: `src/radar/contracts.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/daemon/methods.ts`
- Modify: `src/daemon/watcher.ts` (wires Task 7's `notifyCollisions` and this task's `ContractService.checkAndNotify` into the debounce callback)
- Test: `tests/radar/contracts.test.ts`
- Test: `tests/mcp/tools.test.ts` (extend)

**Interfaces:**
- Consumes: `ContractRepo` (Task 2), `checkCollisions` (Task 6),
  `extractSymbols`/`languageForPath` (Task 3), `MessageBus` (existing, M2).
- Produces: `class ContractService { declare(opts): ContractRow; checkAndNotify(workspaceId, path, currentSource): void }`.
  `buildTools` gains two required constructor-style params (a radar-check
  function and a `ContractService`), consumed only by
  `src/daemon/methods.ts`'s `start()`.

- [ ] **Step 1: Write the failing `ContractService` test**

```ts
// tests/radar/contracts.test.ts
import { beforeAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { ContractRepo } from '../../src/db/repositories/contract.js';
import { MessageBus } from '../../src/domain/bus.js';
import { SessionManager } from '../../src/domain/session.js';
import { ContractService } from '../../src/radar/contracts.js';
import { initGrammars } from '../../src/radar/grammars.js';

beforeAll(async () => { await initGrammars(); });

function seed(db: ReturnType<typeof openDatabase>) {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  const sessions = new SessionRepo(db);
  for (const id of ['s_owner', 's_user']) {
    sessions.insert({
      id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
  }
}

describe('ContractService', () => {
  test('declare computes a sig_hash from the symbol\'s current public shape', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    const contract = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login(user: string): boolean {\n  return true;\n}\n',
    );
    expect(contract.symbolFqn).toBe('src/auth.ts#login');
    expect(contract.sigHash).toBeTruthy();
  });

  test('a body-only change to the same signature does not change sig_hash', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    const a = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login(user: string): boolean {\n  return true;\n}\n',
    );
    const repo = new ContractRepo(db);
    const before = repo.findByFqn('ws_1', 'src/auth.ts#login');
    expect(before?.sigHash).toBe(a.sigHash);
  });

  test('the caller is responsible for calling checkAndNotify after a real re-index; a signature-changing edit fires a system message to subscribers', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login(user: string): boolean {\n  return true;\n}\n',
    );

    const bus = new MessageBus(db, new SessionManager(db));
    new ContractRepo(db).addSubscriber(
      new ContractRepo(db).findByFqn('ws_1', 'src/auth.ts#login')!.id, 's_user', 'now',
    );

    service.checkAndNotify(
      'ws_1', 'src/auth.ts',
      'export function login(user: string, token: string): boolean {\n  return true;\n}\n',
      bus,
    );

    const inbox = bus.inbox('ws_1', 's_user');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.trust).toBe('system');
  });
});
```

- [ ] **Step 2: Verify failure, then implement**

Run: `bun test tests/radar/contracts.test.ts` — expect FAIL (module not found).

```ts
// src/radar/contracts.ts
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { ContractRepo, type ContractRow } from '../db/repositories/contract.js';
import { extractSymbols, type SymbolRange } from './symbols.js';
import { languageForPath } from './grammars.js';
import type { MessageBus } from '../domain/bus.js';
import { CrossweaveError } from '../core/errors.js';

export interface DeclareOpts {
  workspaceId: string;
  ownerSession: string;
  symbolFqn: string; // "<path>#<name>"
  stableBy?: string;
}

function parseFqn(fqn: string): { path: string; name: string } {
  const hashIndex = fqn.lastIndexOf('#');
  if (hashIndex === -1) {
    throw new CrossweaveError('INVALID_SYMBOL_FQN', `Expected <file>#<Name>, got: ${fqn}`);
  }
  return { path: fqn.slice(0, hashIndex), name: fqn.slice(hashIndex + 1) };
}

function findSymbol(source: string, path: string, name: string): SymbolRange {
  const language = languageForPath(path);
  const symbols = language ? extractSymbols(source, language) : undefined;
  const found = symbols?.find((s) => s.name === name);
  if (!found) {
    throw new CrossweaveError('CONTRACT_TARGET_NOT_FOUND', `No top-level symbol named "${name}" in ${path}`);
  }
  return found;
}

/**
 * A hash of the symbol's PUBLIC SHAPE only — for a function/method, its
 * signature line (everything up to the first `{`); a body-only edit must
 * never change this, or a contract would fire on every unrelated
 * implementation tweak, defeating the point of scoping it to the interface.
 */
function signatureHash(body: string): string {
  const braceIndex = body.indexOf('{');
  const signature = (braceIndex === -1 ? body : body.slice(0, braceIndex)).replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(signature).digest('hex');
}

export class ContractService {
  private readonly repo: ContractRepo;

  constructor(db: Database) {
    this.repo = new ContractRepo(db);
  }

  declareFromSource(opts: DeclareOpts, currentSource: string): ContractRow {
    const { path, name } = parseFqn(opts.symbolFqn);
    const symbol = findSymbol(currentSource, path, name);
    const sigHash = signatureHash(currentSource.slice(symbol.startByte, symbol.endByte));

    const existing = this.repo.findByFqn(opts.workspaceId, opts.symbolFqn);
    if (existing) {
      this.repo.updateSigHash(existing.id, sigHash);
      return { ...existing, sigHash };
    }
    const row: ContractRow = {
      id: newId('ct'),
      workspaceId: opts.workspaceId,
      ownerSession: opts.ownerSession,
      symbolFqn: opts.symbolFqn,
      sigHash,
      declaredAt: new Date().toISOString(),
      stableBy: opts.stableBy ?? null,
    };
    this.repo.insert(row);
    return row;
  }

  /** Auto-subscribes `sessionId` if it isn't already, so the next sig_hash change reaches it. */
  subscribe(contractId: string, sessionId: string): void {
    this.repo.addSubscriber(contractId, sessionId, new Date().toISOString());
  }

  /**
   * Re-derives every declared contract whose `symbolFqn` starts with
   * `path#`, and — if the re-derived `sig_hash` differs from what's
   * stored — updates it and messages every subscriber with the diff.
   * Called by the indexer after a real reindex (Task 4/5's wiring), never
   * directly by a CLI command.
   */
  checkAndNotify(workspaceId: string, path: string, currentSource: string, bus: MessageBus): void {
    for (const contract of this.repo.listByWorkspace(workspaceId)) {
      const { path: cPath, name } = parseFqn(contract.symbolFqn);
      if (cPath !== path) continue;
      const language = languageForPath(path);
      const symbols = language ? extractSymbols(currentSource, language) : undefined;
      const symbol = symbols?.find((s) => s.name === name);
      if (!symbol) continue; // symbol removed or file unparseable this pass — leave the contract as-is

      const newSigHash = signatureHash(currentSource.slice(symbol.startByte, symbol.endByte));
      if (newSigHash === contract.sigHash) continue;

      const oldHash = contract.sigHash;
      this.repo.updateSigHash(contract.id, newSigHash);
      for (const subscriberId of this.repo.listSubscribers(contract.id)) {
        bus.send({
          workspaceId,
          fromSession: contract.ownerSession,
          toSession: subscriberId,
          trust: 'system',
          body: `Contract changed: ${contract.symbolFqn} — signature hash ${oldHash.slice(0, 8)} -> ${newSigHash.slice(0, 8)}`,
        });
      }
    }
  }
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/radar/contracts.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Extend `buildTools` with `cw_check` and `cw_declare_contract`**

In `src/mcp/tools.ts`, change the header comment and signature, and add the
two tools. The function now needs `checkCollisions` (Task 6) plus a way to
call it against the live `FileClaimRepo`, and `ContractService`:

```ts
// src/mcp/tools.ts — updated imports and signature
import type { McpTool, McpToolResult } from './protocol.js';
import type { MessageBus } from '../domain/bus.js';
import type { ContextStore } from '../domain/context-store.js';
import type { ContextEntryRow } from '../db/repositories/context.js';
import type { FileClaimRepo } from '../db/repositories/file-claim.js';
import { checkCollisions } from '../radar/collisions.js';
import type { ContractService } from '../radar/contracts.js';
import { CrossweaveError } from '../core/errors.js';

// ... text/requireString/optionalString/resolveById unchanged ...

/** All eight tools: the six from M2 plus cw_check and cw_declare_contract. */
export function buildTools(
  sessionId: string,
  workspaceId: string,
  bus: MessageBus,
  store: ContextStore,
  fileClaims: FileClaimRepo,
  contracts: ContractService,
): McpTool[] {
  return [
    // ...the six existing tools, unchanged...
    {
      name: 'cw_check',
      description: 'Check whether any other session in this workspace has divergent changes to a file or symbol.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative file path' },
          symbol: { type: 'string', description: 'Optional symbol name to scope the check to' },
        },
        required: ['path'],
      },
      handler: async (args) => {
        const path = requireString(args, 'path');
        const symbol = optionalString(args, 'symbol');
        const collisions = checkCollisions(fileClaims, { workspaceId, sessionId, path, symbol });
        return text(collisions);
      },
    },
    {
      name: 'cw_declare_contract',
      description: "Pin a symbol's current public signature as a contract. Sessions referencing it are notified if the signature later changes.",
      inputSchema: {
        type: 'object',
        properties: {
          symbolFqn: { type: 'string', description: 'e.g. "src/auth.ts#AuthService"' },
          source: { type: 'string', description: "The file's current full source, used to compute the signature" },
        },
        required: ['symbolFqn', 'source'],
      },
      handler: async (args) => {
        const symbolFqn = requireString(args, 'symbolFqn');
        const source = requireString(args, 'source');
        try {
          const contract = contracts.declareFromSource({ workspaceId, ownerSession: sessionId, symbolFqn }, source);
          return text({ id: contract.id, symbolFqn: contract.symbolFqn, sigHash: contract.sigHash });
        } catch (err) {
          if (err instanceof CrossweaveError) throw err;
          throw new CrossweaveError('CONTRACT_DECLARE_FAILED', String(err));
        }
      },
    },
  ];
}
```

Update the doc comment above `buildTools` (it currently reads "Exactly the
six real tools. `cw_check` and `cw_declare_contract` arrive in M3.") to:
`/** Eight tools: the six messaging/context tools from M2, plus cw_check and cw_declare_contract from M3. */`

- [ ] **Step 5: Update the call site in `src/daemon/methods.ts`**

```ts
import { ContractService } from '../radar/contracts.js';
// ...
const contracts = new ContractService(db);
```

```ts
        const tools = buildTools(row.id, row.workspaceId, bus, contextStore, fileClaims, contracts);
```

And add the `contract.declare` RPC method (the CLI command in Task 10 calls
this; `source` is read by the CLI from the file on disk, kept out of the
daemon so the daemon never needs its own filesystem read for a caller's
argument beyond what `assertContained` already governs elsewhere):

```ts
    'contract.declare': (p) => {
      const contract = contracts.declareFromSource(
        {
          workspaceId: str(p, 'workspaceId'),
          ownerSession: str(p, 'sessionId'),
          symbolFqn: str(p, 'symbolFqn'),
          stableBy: optionalStr(p, 'stableBy'),
        },
        str(p, 'source'),
      );
      return { id: contract.id, symbolFqn: contract.symbolFqn, sigHash: contract.sigHash };
    },
```

- [ ] **Step 6: Update `tests/mcp/tools.test.ts`'s existing `buildTools` calls**

Every one of the eight `buildTools(x.id, workspaceId, bus, store)` call
sites in this file (one per `it(...)` block) needs the two new arguments
appended: `buildTools(x.id, workspaceId, bus, store, new FileClaimRepo(db), new ContractService(db))`.
Add the import alongside the file's existing ones:

```ts
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { ContractService } from '../../src/radar/contracts.js';
```

And replace the first test's exact-tool-list assertion:

```ts
  it('exposes exactly the eight real tools', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const bus = new MessageBus(db, sessions);
    const store = new ContextStore(db);
    const tools = buildTools(a.id, workspaceId, bus, store, new FileClaimRepo(db), new ContractService(db));

    expect(tools.map((t) => t.name).sort()).toEqual([
      'cw_broadcast', 'cw_check', 'cw_declare_contract', 'cw_handoff',
      'cw_inbox', 'cw_publish_context', 'cw_read_context', 'cw_send',
    ]);
  }, 30_000);
```

- [ ] **Step 7: Wire retroactive collision and contract notification into the watcher**

Task 5's `RadarWatcherRegistry` only calls `reindexSession` on each debounce
tick. Now that `notifyCollisions` (Task 7) and `ContractService` (this task)
both exist, extend it to call both afterward — this is the step that
actually makes the M3 design doc §5 "everyone else" delivery path real.

In `src/daemon/watcher.ts`:

```ts
import type { Database } from 'bun:sqlite';
import { watch, type FSWatcher } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RadarIndexer, type IndexableSession } from '../radar/indexer.js';
import { createDebouncer } from '../radar/watch-debounce.js';
import { FileClaimRepo } from '../db/repositories/file-claim.js';
import { NotificationGate } from '../radar/noise.js';
import { notifyCollisions } from '../radar/retro-notify.js';
import type { MessageBus } from '../domain/bus.js';
import type { ContractService } from '../radar/contracts.js';

const DEBOUNCE_MS = 500;

export class RadarWatcherRegistry {
  private readonly indexer: RadarIndexer;
  private readonly claims: FileClaimRepo;
  private readonly gate = new NotificationGate();
  private readonly watchers = new Map<string, { fsWatcher: FSWatcher; debouncer: ReturnType<typeof createDebouncer> }>();

  constructor(
    db: Database,
    private readonly bus: MessageBus,
    private readonly contracts: ContractService,
  ) {
    this.indexer = new RadarIndexer(db);
    this.claims = new FileClaimRepo(db);
  }

  start(session: IndexableSession): void {
    this.stop(session.id);
    const debouncer = createDebouncer(() => {
      void this.reindexAndNotify(session).catch((err: unknown) => {
        process.stderr.write(`crossweave: radar reindex failed for session ${session.id}: ${String(err)}\n`);
      });
    }, DEBOUNCE_MS);

    let fsWatcher: FSWatcher;
    try {
      fsWatcher = watch(session.worktreePath, { recursive: true }, () => debouncer.trigger());
    } catch (err) {
      process.stderr.write(`crossweave: could not watch worktree for session ${session.id}: ${String(err)}\n`);
      return;
    }
    this.watchers.set(session.id, { fsWatcher, debouncer });
  }

  /**
   * The one place per debounce tick where "reindex" becomes "reindex AND
   * tell everyone who needs to know" — kept as a thin sequencing wrapper
   * (no branching logic of its own) so the three pieces it calls stay each
   * independently unit-tested (Tasks 4, 7, 8) rather than needing a fourth,
   * `fs.watch`-entangled test for the combination.
   */
  private async reindexAndNotify(session: IndexableSession): Promise<void> {
    await this.indexer.reindexSession(session);
    notifyCollisions(this.claims, this.bus, this.gate, {
      workspaceId: session.workspaceId, sessionId: session.id,
    });
    const paths = new Set(this.claims.listBySession(session.id).map((c) => c.path));
    for (const path of paths) {
      let source: string;
      try {
        source = readFileSync(join(session.worktreePath, path), 'utf8');
      } catch {
        continue; // deleted since the reindex read it — skip this pass
      }
      this.contracts.checkAndNotify(session.workspaceId, path, source, this.bus);
    }
  }

  stop(sessionId: string): void {
    const entry = this.watchers.get(sessionId);
    if (!entry) return;
    entry.debouncer.stop();
    entry.fsWatcher.close();
    this.watchers.delete(sessionId);
  }

  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.stop(id);
  }
}
```

Update its construction in `src/daemon/methods.ts` to match the new
constructor (`bus` and `contracts` already exist there by this point in the
file — `bus` from M2, `contracts` from this task's Step 5):

```ts
const radarWatchers = new RadarWatcherRegistry(db, bus, contracts);
```

- [ ] **Step 8: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all green.

- [ ] **Step 9: Commit**

```bash
git add src/radar/contracts.ts src/mcp/tools.ts src/daemon/methods.ts src/daemon/watcher.ts tests/radar/contracts.test.ts tests/mcp/tools.test.ts
git commit -m "feat(radar): cw_check/cw_declare_contract MCP tools, contract.declare RPC, and wire retroactive notify into the watcher"
```

---

### Task 9: `cw radar-hook` CLI subcommand

**Files:**
- Create: `src/cli/commands/radar-hook.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/radar-hook.test.ts`

**Interfaces:**
- Consumes: `radar.check` RPC (Task 6), `NotificationGate`/`references` (Task 7).
- Produces: the `cw radar-hook` subcommand — Task 10's `ClaudePtyAdapter`
  wiring is the only thing that ever invokes it (as a subprocess spawned by
  Claude Code itself, per `PreToolUse`'s contract).

Claude Code's `PreToolUse` hook contract (confirmed during brainstorming
against Claude Code's own docs): the hook process receives one JSON object
on stdin — `{ session_id, cwd, hook_event_name, tool_name, tool_input }` —
and must print one JSON object to stdout, exit 0:
`{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" | "deny" | "ask", additionalContext?: string } }`.
`cwd` is the worktree the agent is running in, which is exactly the
`worktreePath` already stored on that session's row — the correlation
crossweave needs is already there with no new bookkeeping.

- [ ] **Step 1: Write the failing hook-contract test**

This test drives `runRadarHook` (the pure function under the CLI's `run()`)
directly with fixture stdin JSON and a fake RPC caller, rather than
spawning a real subprocess — matching how `tests/cli/blame.test.ts` and
similar tests in this codebase exercise CLI logic without a live daemon.

`runRadarHook` resolves `tool_input.file_path` against `cwd` through
`assertContained`, which calls `realpathSync` on `cwd` — a fixture `cwd` that
doesn't exist on disk makes that throw, which the hook is designed to
swallow into a plain `allow()` (never block on an internal error), but that
would silently defeat these tests rather than exercising the collision path.
The fixture therefore uses a real temporary directory.

```ts
// tests/cli/radar-hook.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRadarHook, type RadarCheckFn } from '../../src/cli/commands/radar-hook.js';

const NO_COLLISION: RadarCheckFn = async () => ({ collisions: [] });
const ONE_COLLISION: RadarCheckFn = async () => ({
  collisions: [{ sessionId: 's_2', sessionName: 'other', path: 'src/x.ts', symbol: 'foo', kind: 'function' }],
});

let cwd: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'cw-radar-hook-'));
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'src', 'x.ts'), 'export function foo() {}\n');
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function stdinFor(toolName: string, filePath: string): string {
  return JSON.stringify({
    session_id: 'claude-session-1',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath },
  });
}

describe('runRadarHook', () => {
  test('no collision: allow, no additionalContext', async () => {
    const out = await runRadarHook(stdinFor('Edit', join(cwd, 'src', 'x.ts')), NO_COLLISION);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test('a collision: still allow, but additionalContext names the other session', async () => {
    const out = await runRadarHook(stdinFor('Write', join(cwd, 'src', 'x.ts')), ONE_COLLISION);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('other');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('foo');
  });

  test('a non-Edit/Write tool call is allowed without calling radar.check at all', async () => {
    let called = false;
    const spy: RadarCheckFn = async () => { called = true; return { collisions: [] }; };
    const out = await runRadarHook(stdinFor('Read', join(cwd, 'src', 'x.ts')), spy);
    expect(called).toBe(false);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('malformed stdin still allows rather than blocking the agent', async () => {
    const out = await runRadarHook('not json at all', NO_COLLISION);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('a file_path escaping cwd is allowed without calling radar.check', async () => {
    let called = false;
    const spy: RadarCheckFn = async () => { called = true; return { collisions: [] }; };
    const out = await runRadarHook(stdinFor('Edit', '/etc/passwd'), spy);
    expect(called).toBe(false);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
```

- [ ] **Step 2: Verify failure, then implement**

Run: `bun test tests/cli/radar-hook.test.ts` — expect FAIL (module not found).

```ts
// src/cli/commands/radar-hook.ts
import { defineCommand } from 'citty';
import { relative } from 'node:path';
import { withClient, currentWorkspaceId } from '../context.js';
import { assertContained } from '../../core/paths.js';
import { NotificationGate } from '../../radar/noise.js';

interface Collision {
  sessionId: string;
  sessionName: string;
  path: string;
  symbol: string | null;
  kind: string;
}

/**
 * `cwd` is all `runRadarHook` itself has to work with — it never sees a
 * workspaceId/sessionId directly. Resolving `cwd` into those is entirely
 * the caller's job (see `radarHookCommand.run()` below); this function
 * signature deliberately does not pretend otherwise.
 */
export type RadarCheckFn = (
  cwd: string, path: string, symbol: string | undefined,
) => Promise<{ collisions: Collision[] }>;

interface PreToolUseInput {
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: { file_path?: unknown };
}

const WATCHED_TOOLS = new Set(['Edit', 'Write']);

// Module-scoped: one hook subprocess per tool call, but a session making
// several calls in quick succession within the same `cw radar-hook`
// PROCESS shares one gate. Cross-process persistence is out of scope for
// M3 — each `cw radar-hook` invocation is a fresh process, so this really
// only coalesces within a single invocation's lifetime; the daemon-side
// retroactive path (Task 5) is where cross-call rate limiting actually
// matters, since that gate lives for the daemon's whole lifetime.
const gate = new NotificationGate();

function allow(additionalContext?: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(additionalContext !== undefined ? { additionalContext } : {}),
    },
  });
}

/** Exported for direct testing — see tests/cli/radar-hook.test.ts. Never throws: a hook that crashes must not block the agent. */
export async function runRadarHook(stdin: string, check: RadarCheckFn): Promise<string> {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin) as PreToolUseInput;
  } catch {
    return allow();
  }

  const toolName = typeof input.tool_name === 'string' ? input.tool_name : undefined;
  if (toolName === undefined || !WATCHED_TOOLS.has(toolName)) return allow();

  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const filePath = typeof input.tool_input?.file_path === 'string' ? input.tool_input.file_path : undefined;
  if (cwd === undefined || filePath === undefined) return allow();

  let repoRelative: string;
  try {
    repoRelative = relative(cwd, assertContained(cwd, filePath));
  } catch {
    return allow(); // path escapes the worktree — not this hook's problem, and never a block
  }

  try {
    const { collisions } = await check(cwd, repoRelative, undefined);
    if (collisions.length === 0) return allow();

    const notifiable = collisions.filter((c) => gate.shouldNotify(cwd, c.path, c.symbol));
    if (notifiable.length === 0) return allow();

    const names = [...new Set(notifiable.map((c) => c.sessionName))].join(', ');
    const symbols = [...new Set(notifiable.map((c) => c.symbol ?? '(whole file)'))].join(', ');
    return allow(`crossweave Radar: session(s) ${names} also have divergent changes to ${repoRelative} (${symbols}).`);
  } catch {
    return allow(); // daemon unreachable, RPC failed, etc. — degrade silently, never block
  }
}

export const radarHookCommand = defineCommand({
  meta: { name: 'radar-hook', description: "Internal: Claude Code's PreToolUse hook entry point" },
  async run() {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const stdin = Buffer.concat(chunks).toString('utf8');

    const out = await runRadarHook(stdin, async (cwd, path, symbol) => {
      return withClient(async (client) => {
        // A hook subprocess is handed `cwd`, not a workspaceId/sessionId —
        // both are resolved here: `workspace.init` is an idempotent
        // upsert-by-root-path (findProjectRoot walks up from `cwd` inside
        // withClient), and the session is whichever row's `worktreePath`
        // matches `cwd` exactly.
        const workspaceId = await currentWorkspaceId(client);
        const sessions = await client.call<{ id: string; worktreePath: string | null }[]>(
          'session.list', { workspaceId },
        );
        const session = sessions.find((s) => s.worktreePath === cwd);
        if (!session) return { collisions: [] };
        return client.call<{ collisions: Collision[] }>('radar.check', {
          workspaceId, sessionId: session.id, path, symbol,
        });
      });
    });

    process.stdout.write(out + '\n');
  },
});
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/cli/radar-hook.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 4: Register the subcommand**

In `src/cli/index.ts`:

```ts
import { radarHookCommand } from './commands/radar-hook.js';
// ...
const main = defineCommand({
  meta: { name: 'cw', version: VERSION, description: 'crossweave — parallel agents that stay mergeable' },
  subCommands: {
    init: initCommand,
    workspace: workspaceCommand,
    session: sessionCommand,
    daemon: daemonCommand,
    gc: gcCommand,
    blame: blameCommand,
    'radar-hook': radarHookCommand,
  },
});
```

- [ ] **Step 5: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all green.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/radar-hook.ts src/cli/index.ts tests/cli/radar-hook.test.ts
git commit -m "feat(cli): cw radar-hook — Claude Code PreToolUse hook entry point"
```

---

### Task 10: `ClaudePtyAdapter` hook injection and `cw contract declare`

**Files:**
- Modify: `src/adapters/claude-pty.ts`
- Create: `src/cli/commands/contract.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/adapters/claude-pty.test.ts` (extend)
- Test: `tests/cli/contract.test.ts`

**Interfaces:**
- Consumes: `contract.declare` RPC (Task 8).
- Produces: nothing further downstream — this is the plan's last task.

- [ ] **Step 1: Extend the existing `claude-pty` test for the injected `--settings`**

`tests/adapters/claude-pty.test.ts` has no `Bun.spawn` mock anywhere — every
existing test spawns a REAL `sh -c '...'` process and asserts on its actual
output (see `collect()` at the top of the file). Match that style: construct
the adapter with a shell command that echoes its own argv back, so the
`--settings` value `spawn()` actually passed can be read from real process
output, not a captured mock call.

```ts
it('spawn injects a scoped PreToolUse hook via --settings, calling cw radar-hook', async () => {
  const adapter = new ClaudePtyAdapter('sh', ['-c', 'for a in "$@"; do echo "ARG:$a"; done', '_']);
  const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
  const read = collect(proc);
  await new Promise<number>((res) => proc.onExit(res));

  const lines = read().split('\n');
  expect(lines).toContain('ARG:--settings');
  const settingsLine = lines.find((l) => l.startsWith('ARG:') && l.includes('"hooks"'));
  expect(settingsLine).toBeDefined();
  const settings = JSON.parse(settingsLine!.slice('ARG:'.length));
  expect(settings.hooks.PreToolUse[0].matcher).toBe('Edit|Write');
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('radar-hook');
  expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
});
```

- [ ] **Step 2: Verify it fails, then implement**

Run: `bun test tests/adapters/claude-pty.test.ts` — expect the new test to FAIL.

```ts
// src/adapters/claude-pty.ts — add near the top, after imports
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `cw` binary's own path — `spawn` runs inside the daemon process, whose
 * PATH is whatever the client forwarded (see `clientEnv` in methods.ts),
 * which may not include wherever `cw` itself was installed, so this cannot
 * just be the bare command name in every case.
 *
 * Three tiers, most to least specific:
 * 1. In a COMPILED build, `process.execPath` is this very `cwd` binary's own
 *    path (a Bun-compiled standalone executable reports itself, not the Bun
 *    runtime) — `scripts/build.ts` always places `cw` and `cwd` side by
 *    side, so a sibling `cw` next to it is the release layout.
 * 2. In DEV (`bun run`), `process.execPath` is wherever `bun` itself lives,
 *    which tier 1 would resolve wrongly — `import.meta.url` instead points
 *    at this module's own real source location, and `cw`'s entry point is
 *    the sibling `src/cli/index.ts`.
 * 3. Neither guess matches (e.g. a global install with the two binaries in
 *    different directories) — fall back to the bare command name and let
 *    PATH resolve it, same as any other sibling-CLI convention.
 */
function cwBinaryPath(): string {
  const siblingOfExecutable = join(dirname(process.execPath), 'cw');
  if (existsSync(siblingOfExecutable)) return siblingOfExecutable;

  const siblingSource = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
  if (existsSync(siblingSource)) return siblingSource;

  return 'cw';
}

function radarHookSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Edit|Write',
          hooks: [{ type: 'command', command: `${cwBinaryPath()} radar-hook`, timeout: 5 }],
        },
      ],
    },
  });
}
```

```ts
  spawn(opts: SpawnOptions): AgentProcess {
    let wrapper: PtyProcess | undefined;

    const proc = Bun.spawn(
      [this.command, ...this.args, '--settings', radarHookSettings()],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, TERM: 'xterm-256color' },
        terminal: {
          cols: opts.cols,
          rows: opts.rows,
          data(_terminal: unknown, chunk: string | Uint8Array) {
            const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
            wrapper?.emit(text);
          },
        },
      },
    ) as unknown as BunPtyProcess;

    wrapper = new PtyProcess(proc);
    return wrapper;
  }
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/adapters/claude-pty.test.ts`
Expected: PASS (all tests, including the new one)

- [ ] **Step 4: Write the failing `cw contract declare` CLI test**

```ts
// tests/cli/contract.test.ts
import { describe, expect, test } from 'bun:test';
import { parseContractTarget } from '../../src/cli/commands/contract.js';

describe('parseContractTarget', () => {
  test('splits "<file>#<Name>" on the LAST hash, so a path containing "#" still parses', () => {
    expect(parseContractTarget('src/auth.ts#AuthService')).toEqual({
      symbolFqn: 'src/auth.ts#AuthService', path: 'src/auth.ts', name: 'AuthService',
    });
  });

  test('rejects a target with no "#"', () => {
    expect(() => parseContractTarget('src/auth.ts')).toThrow(/Expected/);
  });
});
```

- [ ] **Step 5: Verify failure, then implement**

Run: `bun test tests/cli/contract.test.ts` — expect FAIL (module not found).

```ts
// src/cli/commands/contract.ts
import { realpathSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { CrossweaveError } from '../../core/errors.js';
import { assertContained } from '../../core/paths.js';

export function parseContractTarget(target: string): { symbolFqn: string; path: string; name: string } {
  const hashIndex = target.lastIndexOf('#');
  if (hashIndex === -1) {
    throw new CrossweaveError('INVALID_ARGUMENTS', `Expected <file>#<Name>, e.g. src/auth.ts#AuthService, got: ${target}`);
  }
  return { symbolFqn: target, path: target.slice(0, hashIndex), name: target.slice(hashIndex + 1) };
}

const declareCommand = defineCommand({
  meta: { name: 'declare', description: "Pin a symbol's current signature as a contract" },
  args: {
    symbol: { type: 'positional', description: '<file>#<Name>', required: true },
    session: { type: 'string', description: 'Session id or name declaring this contract', required: true },
    'stable-by': { type: 'string', description: 'ISO 8601 timestamp this contract is expected to hold until', required: false },
  },
  async run({ args }) {
    try {
      const { symbolFqn, path } = parseContractTarget(args.symbol);
      await withClient(async (client, projectRoot) => {
        const workspaceId = await currentWorkspaceId(client);
        const root = realpathSync(projectRoot);
        const repoRelativePath = relative(root, assertContained(root, resolve(process.cwd(), path)));
        const source = readFileSync(assertContained(root, resolve(process.cwd(), path)), 'utf8');
        const result = await client.call<{ id: string; symbolFqn: string; sigHash: string }>('contract.declare', {
          workspaceId,
          sessionId: args.session,
          symbolFqn: `${repoRelativePath}#${symbolFqn.slice(symbolFqn.lastIndexOf('#') + 1)}`,
          stableBy: args['stable-by'],
          source,
        });
        process.stdout.write(`declared ${result.symbolFqn} (sig ${result.sigHash.slice(0, 8)})\n`);
      });
    } catch (err) { fail(err); }
  },
});

export const contractCommand = defineCommand({
  meta: { name: 'contract', description: 'Manage symbol contracts' },
  subCommands: { declare: declareCommand },
});
```

- [ ] **Step 6: Register the subcommand**

In `src/cli/index.ts`:

```ts
import { contractCommand } from './commands/contract.js';
// ...
    contract: contractCommand,
```

- [ ] **Step 7: Run to verify the parser test passes, then typecheck and full suite**

Run: `bun test tests/cli/contract.test.ts`
Expected: PASS (2 tests)

Run: `bun run typecheck && bun test`
Expected: 0 errors, all green — this is the plan's last task, so this is
also the full-branch baseline the final whole-branch review will start from.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/claude-pty.ts src/cli/commands/contract.ts src/cli/index.ts tests/adapters/claude-pty.test.ts tests/cli/contract.test.ts
git commit -m "feat: wire the PreToolUse hook into ClaudePtyAdapter and add cw contract declare"
```

---

## Post-plan note for the controller (not a task)

`session.mcpInfo`'s consumers and any future TUI/ACP client should know the
tool count moved from six to eight; no plan task updates a changelog file
because this repository does not have one yet. After the final whole-branch
review, write `docs/superpowers/specs/2026-08-11-m3-known-limitations.md`
(matching the M0/M1/M2 precedent) — the noise-control window resetting on
daemon restart, the reference-check's ripgrep approximation, no true import
graph, blocking mode deferred to M5, and shared (`--no-worktree`) sessions
not participating in the watcher are all worth naming there rather than
being rediscovered in M4.
