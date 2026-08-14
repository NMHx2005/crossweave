# M6b — Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** macOS desktop notifications for four crossweave events — a new Radar
collision, a write blocked by Safe Mode, `cw land` finishing, and a background
convergence trial changing state — so a user away from the terminal still learns about
them, with click-through to jump back to the relevant session when `terminal-notifier`
is installed.

**Architecture:** One shared `notify()` function every trigger point calls through —
mirrors `decideBlocked` (M5a/M5b) and `recordUsage` (M6a)'s established
one-function-many-callers shape. A `notify_config` DB table (workspace-scoped, mirrors
`config_trust` exactly) holds the on/off preference, read live through the RPC layer
so a toggle takes effect immediately on the running daemon, never requiring a restart.
Sending is a thin OS-boundary layer (`terminal-notifier` if present, `osascript`
fallback) never unit-tested against a real banner, matching this project's own
established precedent for OS-boundary code.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, `node:child_process` (`execFileSync`),
`osascript`/`terminal-notifier` (macOS system tools, no new npm dependency).

**Spec:** `docs/superpowers/specs/2026-08-14-m6b-push-notification-design.md`

## Global Constraints

- Bun >= 1.3.5, TypeScript strict mode — no `any`, `!`, `@ts-ignore` without a stated reason.
- `bun run typecheck` (tsc --noEmit) and `bun test` must both be clean before any task is done.
- Conventional Commits style; one logical change per commit.
- Never commit to `main` — this plan runs entirely on a feature branch/worktree.
- Follow existing repo patterns exactly: repo files under `src/db/repositories/`,
  domain/policy logic in its own small module (`src/notify/`, mirroring `src/radar/`,
  `src/domain/`), RPC handlers in `src/daemon/methods.ts`, CLI subcommands under
  `src/cli/commands/`.
- **Every subprocess spawn uses `execFileSync`/`Bun.spawn` with an argv array — never
  a concatenated shell/AppleScript string** (CLAUDE.md §5; design doc §3.2). `path`/
  `symbol` values from Radar can contain arbitrary characters.
- macOS only (`process.platform === 'darwin'`) — every other platform gets a no-op
  `send`, silently, no warning (design doc §3.4, §1 non-goals).
- `notify()` and everything it calls never throws to its caller and never blocks an
  RPC's real result (design doc §3.5) — a notification is observability, not a safety
  mechanism.
- SCHEMA_VERSION goes from 8 to 9. New table `notify_config`, workspace-scoped,
  mirroring `config_trust`'s exact shape (absence = every default on).

---

### Task 1: Schema v9 — `notify_config` table + `NotifyConfigRepo`

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/repositories/notify-config.ts`
- Create: `tests/db/notify-config-repo.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `NotifyConfigRepo` — `get(workspaceId): NotifyConfigRow | undefined`,
  `setEnabled(workspaceId, enabled: boolean): void`, `setEvent(workspaceId, event:
  'collision'|'blocked'|'land'|'convergence', enabled: boolean): void`,
  `isEnabled(workspaceId, event): boolean` (the one later tasks actually call — folds
  "no row = everything on" and the master `enabled` switch into one boolean, so no
  caller needs to know the row-absence convention). `NotifyConfigRow = { workspaceId:
  string; enabled: boolean; collision: boolean; blocked: boolean; land: boolean;
  convergence: boolean }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/notify-config-repo.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { NotifyConfigRepo } from '../../src/db/repositories/notify-config.js';

function seed() {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T2',
  });
  return new NotifyConfigRepo(db);
}

describe('NotifyConfigRepo', () => {
  test('get returns undefined for a workspace with no row yet', () => {
    expect(seed().get('ws_1')).toBeUndefined();
  });

  test('isEnabled defaults every event to true when no row exists', () => {
    const repo = seed();
    expect(repo.isEnabled('ws_1', 'collision')).toBe(true);
    expect(repo.isEnabled('ws_1', 'blocked')).toBe(true);
    expect(repo.isEnabled('ws_1', 'land')).toBe(true);
    expect(repo.isEnabled('ws_1', 'convergence')).toBe(true);
  });

  test('setEnabled(false) turns every event off via isEnabled, regardless of per-event columns', () => {
    const repo = seed();
    repo.setEnabled('ws_1', false);
    expect(repo.isEnabled('ws_1', 'collision')).toBe(false);
    expect(repo.isEnabled('ws_1', 'land')).toBe(false);
    const row = repo.get('ws_1')!;
    expect(row.enabled).toBe(false);
    // Per-event columns are untouched by the master switch — still their defaults.
    expect(row.collision).toBe(true);
  });

  test('setEnabled(true) after false turns everything back on', () => {
    const repo = seed();
    repo.setEnabled('ws_1', false);
    repo.setEnabled('ws_1', true);
    expect(repo.isEnabled('ws_1', 'collision')).toBe(true);
  });

  test('setEvent turns off exactly one event, leaving the others and the master switch alone', () => {
    const repo = seed();
    repo.setEvent('ws_1', 'collision', false);
    expect(repo.isEnabled('ws_1', 'collision')).toBe(false);
    expect(repo.isEnabled('ws_1', 'blocked')).toBe(true);
    expect(repo.isEnabled('ws_1', 'land')).toBe(true);
    expect(repo.isEnabled('ws_1', 'convergence')).toBe(true);
  });

  test('setEvent creates a row on first use (no prior setEnabled call needed)', () => {
    const repo = seed();
    repo.setEvent('ws_1', 'blocked', false);
    const row = repo.get('ws_1')!;
    expect(row.enabled).toBe(true); // master switch defaults on even on first-ever write
    expect(row.blocked).toBe(false);
  });

  test('isEnabled is false when the master switch is off even if the per-event column is true', () => {
    const repo = seed();
    repo.setEnabled('ws_1', false);
    repo.setEvent('ws_1', 'collision', true); // explicitly re-enabled at the event level
    expect(repo.isEnabled('ws_1', 'collision')).toBe(false); // master switch still wins
  });

  test('preferences are workspace-scoped, not shared', () => {
    const db = openDatabase(':memory:');
    const workspaces = new WorkspaceRepo(db);
    workspaces.insert({ id: 'ws_1', name: 'a', rootPath: '/tmp/a', createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2' });
    workspaces.insert({ id: 'ws_2', name: 'b', rootPath: '/tmp/b', createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2' });
    const repo = new NotifyConfigRepo(db);
    repo.setEnabled('ws_1', false);
    expect(repo.isEnabled('ws_1', 'collision')).toBe(false);
    expect(repo.isEnabled('ws_2', 'collision')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/db/notify-config-repo.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/repositories/notify-config.js'`
(doesn't exist yet).

- [ ] **Step 3: Migrate the schema**

In `src/db/schema.ts`, find:

```ts
export const SCHEMA_VERSION = 8;
```

Replace with:

```ts
export const SCHEMA_VERSION = 9;
```

Find the end of the `MIGRATIONS` array (the M6a cost-columns migration, currently the
last element):

```ts
  [
    // Budget/burn backend (M6a): cost accounting alongside the token accounting
    // M0 already had columns for but never wrote to. Independent, optional
    // budgets — a session can have a token budget, a cost budget, both, or
    // neither (design doc §3.1).
    `ALTER TABLE session ADD COLUMN cost_spent_usd REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE session ADD COLUMN cost_budget_usd REAL`,
  ],
];
```

Replace with:

```ts
  [
    // Budget/burn backend (M6a): cost accounting alongside the token accounting
    // M0 already had columns for but never wrote to. Independent, optional
    // budgets — a session can have a token budget, a cost budget, both, or
    // neither (design doc §3.1).
    `ALTER TABLE session ADD COLUMN cost_spent_usd REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE session ADD COLUMN cost_budget_usd REAL`,
  ],
  [
    // Push notifications (M6b): per-workspace notify preference, mirroring
    // config_trust's exact shape — a missing row means "every default is on",
    // not "nothing configured yet fails closed". Read live through an RPC
    // (never cached into a CrossweaveConfig snapshot), so a `cw config notify
    // off` takes effect on the very next event, no daemon restart needed —
    // see design doc §3.3's own correction note for why that matters.
    `CREATE TABLE notify_config (
    workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
    enabled      INTEGER NOT NULL DEFAULT 1,
    collision    INTEGER NOT NULL DEFAULT 1,
    blocked      INTEGER NOT NULL DEFAULT 1,
    land         INTEGER NOT NULL DEFAULT 1,
    convergence  INTEGER NOT NULL DEFAULT 1
  )`,
  ],
];
```

- [ ] **Step 4: Implement `src/db/repositories/notify-config.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/db/notify-config-repo.test.ts`
Expected: all PASS.

- [ ] **Step 6: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/repositories/notify-config.ts tests/db/notify-config-repo.test.ts
git commit -m "feat(db): schema v9 — notify_config table, NotifyConfigRepo

Workspace-scoped notify preference, mirroring config_trust's exact
shape (a missing row means every default is on). Read live through
an RPC in a later task, never cached into a CrossweaveConfig
snapshot, so cw config notify off takes effect immediately."
```

---

### Task 2: `notify()` — the shared dispatcher function

The one function every trigger point calls through. Pure policy: given an event and
its dependencies, decide whether to send, and what.

**Files:**
- Create: `src/notify/dispatcher.ts`
- Create: `tests/notify/dispatcher.test.ts`

**Interfaces:**
- Consumes: `NotificationGate` (existing, `src/radar/noise.js`).
- Produces: `NotifyEvent` (discriminated union), `NotifyDispatcherDeps`, `notify(deps,
  event): void`. Every later task's trigger point calls this directly.

- [ ] **Step 1: Write the failing tests**

Create `tests/notify/dispatcher.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { NotificationGate } from '../../src/radar/noise.js';
import { notify, type NotifyEvent, type NotifyDispatcherDeps } from '../../src/notify/dispatcher.js';

interface Sent { title: string; message: string; clickCommand: string[] | undefined }

function deps(overrides: Partial<NotifyDispatcherDeps> = {}): { deps: NotifyDispatcherDeps; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    deps: {
      gate: new NotificationGate(),
      isEnabled: () => true,
      send: (title, message, clickCommand) => { sent.push({ title, message, clickCommand }); },
      ...overrides,
    },
  };
}

describe('notify', () => {
  test('collision: title/message name both sessions, path and symbol; click attaches to sessionB', () => {
    const { deps: d, sent } = deps();
    const event: NotifyEvent = {
      kind: 'collision', sessionA: 'auth', sessionB: 'payments',
      path: 'src/user.ts', symbol: 'User', workspaceId: 'ws_1',
    };
    notify(d, event);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain('auth');
    expect(sent[0]!.message).toContain('payments');
    expect(sent[0]!.message).toContain('src/user.ts');
    expect(sent[0]!.message).toContain('User');
    expect(sent[0]!.clickCommand).toEqual(['cw', 'session', 'attach', 'payments']);
  });

  test('collision: null symbol renders without a dangling separator', () => {
    const { deps: d, sent } = deps();
    notify(d, { kind: 'collision', sessionA: 'a', sessionB: 'b', path: 'x.ts', symbol: null, workspaceId: 'ws_1' });
    expect(sent[0]!.message).not.toContain('null');
    expect(sent[0]!.message).toContain('x.ts');
  });

  test('blocked: names the session and path; click attaches to it', () => {
    const { deps: d, sent } = deps();
    notify(d, { kind: 'blocked', session: 'auth', path: 'src/user.ts', symbol: 'User', workspaceId: 'ws_1' });
    expect(sent[0]!.title).toContain('blocked');
    expect(sent[0]!.message).toContain('auth');
    expect(sent[0]!.message).toContain('src/user.ts');
    expect(sent[0]!.clickCommand).toEqual(['cw', 'session', 'attach', 'auth']);
  });

  test('land ok: names the session and base branch; click lists sessions (no single attach target)', () => {
    const { deps: d, sent } = deps();
    notify(d, { kind: 'land', session: 'auth', ok: true, baseBranch: 'main', workspaceId: 'ws_1' });
    expect(sent[0]!.title).toContain('land');
    expect(sent[0]!.message).toContain('auth');
    expect(sent[0]!.message).toContain('main');
    expect(sent[0]!.clickCommand).toEqual(['cw', 'session', 'list']);
  });

  test('land failure: names the session and reason', () => {
    const { deps: d, sent } = deps();
    notify(d, { kind: 'land', session: 'auth', ok: false, reason: 'LAND_CONFLICT', workspaceId: 'ws_1' });
    expect(sent[0]!.title).toContain('failed');
    expect(sent[0]!.message).toContain('auth');
    expect(sent[0]!.message).toContain('LAND_CONFLICT');
  });

  test('convergence: names both sessions and the state transition', () => {
    const { deps: d, sent } = deps();
    notify(d, { kind: 'convergence', sessionA: 'auth', sessionB: 'payments', from: 'clean', to: 'conflict', workspaceId: 'ws_1' });
    expect(sent[0]!.message).toContain('auth');
    expect(sent[0]!.message).toContain('payments');
    expect(sent[0]!.message).toContain('clean');
    expect(sent[0]!.message).toContain('conflict');
    expect(sent[0]!.clickCommand).toEqual(['cw', 'session', 'list']);
  });

  test('isEnabled(false) for this event: nothing is sent, gate is never consulted', () => {
    let gateCalled = false;
    const gate = new NotificationGate();
    const originalShouldNotify = gate.shouldNotify.bind(gate);
    gate.shouldNotify = (...args) => { gateCalled = true; return originalShouldNotify(...args); };
    const { deps: base, sent } = deps({ gate, isEnabled: () => false });
    notify(base, { kind: 'blocked', session: 'auth', path: 'x.ts', symbol: null, workspaceId: 'ws_1' });
    expect(sent).toHaveLength(0);
    expect(gateCalled).toBe(false);
  });

  test('collision does NOT consult the gate a second time — always sends when isEnabled is true', () => {
    // Per design doc §3.1: the caller (background watcher path) already gated once
    // before deciding to call notify() at all; notify() must not gate collision a
    // second time under a different key, or it would silently halve the advisory
    // budget the moment M6b ships.
    const gate = new NotificationGate();
    gate.shouldNotify('auth', 'x.ts', null); // consume the one slot for this triple
    const { deps: d, sent } = deps({ gate });
    notify(d, { kind: 'collision', sessionA: 'a', sessionB: 'auth', path: 'x.ts', symbol: null, workspaceId: 'ws_1' });
    expect(sent).toHaveLength(1); // still sends — collision never re-checks the gate
  });

  test('blocked DOES consult the gate — a repeat block on the same session/path/symbol is throttled', () => {
    const gate = new NotificationGate();
    const { deps: d, sent } = deps({ gate });
    const event: NotifyEvent = { kind: 'blocked', session: 'auth', path: 'x.ts', symbol: 'foo', workspaceId: 'ws_1' };
    notify(d, event);
    notify(d, event);
    expect(sent).toHaveLength(1);
  });

  test('land DOES consult the gate, keyed by session, not by path — a second land attempt is throttled', () => {
    const gate = new NotificationGate();
    const { deps: d, sent } = deps({ gate });
    notify(d, { kind: 'land', session: 'auth', ok: true, baseBranch: 'main', workspaceId: 'ws_1' });
    notify(d, { kind: 'land', session: 'auth', ok: false, reason: 'x', workspaceId: 'ws_1' });
    expect(sent).toHaveLength(1);
  });

  test('convergence DOES consult the gate, keyed by the sorted session pair — order does not matter', () => {
    const gate = new NotificationGate();
    const { deps: d, sent } = deps({ gate });
    notify(d, { kind: 'convergence', sessionA: 'a', sessionB: 'b', from: 'clean', to: 'conflict', workspaceId: 'ws_1' });
    notify(d, { kind: 'convergence', sessionA: 'b', sessionB: 'a', from: 'conflict', to: 'test_fail', workspaceId: 'ws_1' });
    expect(sent).toHaveLength(1);
  });

  test('a send() that throws is caught, logged once, never propagates', () => {
    const { deps: base } = deps({ send: () => { throw new Error('boom'); } });
    expect(() => notify(base, { kind: 'land', session: 'auth', ok: true, baseBranch: 'main', workspaceId: 'ws_1' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/notify/dispatcher.test.ts`
Expected: FAIL — `Cannot find module '../../src/notify/dispatcher.js'` (doesn't exist yet).

- [ ] **Step 3: Implement `src/notify/dispatcher.ts`**

```ts
import type { NotificationGate } from '../radar/noise.js';
import type { MergeTrialResult } from '../db/repositories/merge-trial.js';
import type { NotifyEventKind } from '../db/repositories/notify-config.js';

export type NotifyEvent =
  | { kind: 'collision'; sessionA: string; sessionB: string; path: string; symbol: string | null; workspaceId: string }
  | { kind: 'blocked'; session: string; path: string; symbol: string | null; workspaceId: string }
  | { kind: 'land'; session: string; ok: true; baseBranch: string; workspaceId: string }
  | { kind: 'land'; session: string; ok: false; reason: string; workspaceId: string }
  | { kind: 'convergence'; sessionA: string; sessionB: string; from: MergeTrialResult; to: MergeTrialResult; workspaceId: string };

export interface NotifyDispatcherDeps {
  gate: NotificationGate;
  /** Reads notify_config live (Task 1) — never a cached CrossweaveConfig snapshot. */
  isEnabled: (workspaceId: string, kind: NotifyEventKind) => boolean;
  /** Injected so tests never spawn a real process — Task 3 provides the real one. */
  send: (title: string, message: string, clickCommand: string[] | undefined) => void;
}

let loggedSendFailureOnce = false;

function symbolSuffix(symbol: string | null): string {
  return symbol !== null ? ` (${symbol})` : '';
}

/**
 * Formats one event into (title, message, clickCommand). A pure function of the
 * event alone — no gating, no I/O — kept separate from `notify` so the "what does
 * this event look like" question is easy to unit test independently of throttling.
 */
function format(event: NotifyEvent): { title: string; message: string; clickCommand: string[] } {
  switch (event.kind) {
    case 'collision':
      return {
        title: 'crossweave',
        message: `${event.sessionA} ↔ ${event.sessionB}: ${event.path}${symbolSuffix(event.symbol)}`,
        clickCommand: ['cw', 'session', 'attach', event.sessionB],
      };
    case 'blocked':
      return {
        title: 'crossweave — blocked',
        message: `${event.session} blocked writing ${event.path}${symbolSuffix(event.symbol)}`,
        clickCommand: ['cw', 'session', 'attach', event.session],
      };
    case 'land':
      return event.ok
        ? {
            title: 'crossweave — land ok',
            message: `${event.session} landed into ${event.baseBranch}`,
            clickCommand: ['cw', 'session', 'list'],
          }
        : {
            title: 'crossweave — land failed',
            message: `${event.session} failed to land: ${event.reason}`,
            clickCommand: ['cw', 'session', 'list'],
          };
    case 'convergence':
      return {
        title: 'crossweave — convergence',
        message: `${event.sessionA} ↔ ${event.sessionB}: ${event.from} → ${event.to}`,
        clickCommand: ['cw', 'session', 'list'],
      };
  }
}

/**
 * Gate key per event kind (design doc §3.1). `collision` deliberately does NOT gate
 * here — the caller (background watcher path) already consulted the SAME gate
 * instance once, to decide whether to send its own advisory message, before ever
 * calling `notify`; gating it again under a different key would silently halve that
 * existing budget. `undefined` means "always send, no throttle" — collision's only
 * case.
 */
function gateKey(event: NotifyEvent): [string, string, string | null] | undefined {
  switch (event.kind) {
    case 'collision':
      return undefined;
    case 'blocked':
      return [event.session, event.path, event.symbol];
    case 'land':
      // '__land__' can never collide with a real file path.
      return [event.session, '__land__', null];
    case 'convergence':
      return [[event.sessionA, event.sessionB].sort().join('\0'), '__convergence__', null];
  }
}

/**
 * The one function every trigger point calls through (design doc §3.1) — mirrors
 * decideBlocked/recordUsage's established shape. Never throws: a formatting bug or a
 * send() failure is caught and logged once per daemon lifetime, because a
 * notification is observability, not a safety mechanism (design doc §3.5).
 */
export function notify(deps: NotifyDispatcherDeps, event: NotifyEvent): void {
  try {
    if (!deps.isEnabled(event.workspaceId, event.kind)) return;
    const key = gateKey(event);
    if (key !== undefined && !deps.gate.shouldNotify(...key)) return;
    const { title, message, clickCommand } = format(event);
    deps.send(title, message, clickCommand);
  } catch (err) {
    if (!loggedSendFailureOnce) {
      loggedSendFailureOnce = true;
      process.stderr.write(`crossweave: notify() failed (further failures this run are silent): ${String(err)}\n`);
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/notify/dispatcher.test.ts`
Expected: all PASS.

- [ ] **Step 5: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/notify/dispatcher.ts tests/notify/dispatcher.test.ts
git commit -m "feat(notify): notify() — shared dispatcher for the 4 push-notification events

One function every trigger point calls through, mirroring
decideBlocked/recordUsage's established shape. Gating is
asymmetric by design: collision never gates a second time (the
caller already did, against the same shared gate, before deciding
to send its own advisory text); blocked/land/convergence each gate
under their own key, namespaced so they can never collide with a
real Radar (sessionId, path, symbol) key."
```

---

### Task 3: `sendMacNotification` — terminal-notifier / osascript, argv-safe

**Files:**
- Create: `src/notify/macos.ts`
- Create: `tests/notify/macos.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `sendMacNotification(title, message, clickCommand): void`,
  `platformSend(): (title, message, clickCommand) => void` — returns
  `sendMacNotification` on `darwin`, a no-op elsewhere (Task 4 wires whichever this
  returns into the daemon's real `NotifyDispatcherDeps.send`).

- [ ] **Step 1: Write the failing tests**

Create `tests/notify/macos.test.ts`:

```ts
import { describe, expect, test, mock } from 'bun:test';

describe('sendMacNotification argv construction', () => {
  test('terminal-notifier present, with a click command: -execute opens Terminal via argv, no shell string', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    mock.module('node:child_process', () => ({
      execFileSync: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === 'which') return 'Users/x/bin/terminal-notifier\n';
        return '';
      },
    }));
    const { sendMacNotification } = await import('../../src/notify/macos.js?t=1');
    sendMacNotification('crossweave', 'auth blocked', ['cw', 'session', 'attach', 'auth']);

    const tn = calls.find((c) => c.cmd.includes('terminal-notifier'));
    expect(tn).toBeDefined();
    expect(tn!.args).toContain('-title');
    expect(tn!.args).toContain('crossweave');
    expect(tn!.args).toContain('-message');
    expect(tn!.args).toContain('auth blocked');
    expect(tn!.args).toContain('-execute');
    // The click command is never concatenated into one shell string element —
    // 'cw session attach auth' as a single joined string would fail this.
    expect(tn!.args).not.toContain('cw session attach auth');
  });

  test('terminal-notifier absent: falls back to osascript, passive only', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    mock.module('node:child_process', () => ({
      execFileSync: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === 'which') throw new Error('not found');
        return '';
      },
    }));
    const { sendMacNotification } = await import('../../src/notify/macos.js?t=2');
    sendMacNotification('crossweave', 'auth blocked', ['cw', 'session', 'attach', 'auth']);

    expect(calls.some((c) => c.cmd === 'osascript')).toBe(true);
    expect(calls.some((c) => c.cmd.includes('terminal-notifier'))).toBe(false);
  });

  test('a message containing a double-quote does not break the osascript argv', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    mock.module('node:child_process', () => ({
      execFileSync: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === 'which') throw new Error('not found');
        return '';
      },
    }));
    const { sendMacNotification } = await import('../../src/notify/macos.js?t=3');
    expect(() => sendMacNotification('crossweave', 'auth ↔ "payments": src/x.ts', undefined)).not.toThrow();
    const osa = calls.find((c) => c.cmd === 'osascript')!;
    // The raw message text is one argv element among osascript's args, never
    // hand-concatenated into the `-e` script string outside of AppleScript's own
    // string-literal escaping.
    expect(osa.args.some((a) => a.includes('auth ↔ "payments": src/x.ts'))).toBe(false);
  });
});

describe('platformSend', () => {
  test('returns sendMacNotification on darwin', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const { platformSend, sendMacNotification } = await import('../../src/notify/macos.js?t=4');
      expect(platformSend()).toBe(sendMacNotification);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  test('returns a no-op on a non-darwin platform', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const { platformSend } = await import('../../src/notify/macos.js?t=5');
      expect(() => platformSend()('t', 'm', undefined)).not.toThrow();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});
```

(`?t=N` query suffixes force Bun's module cache to re-evaluate `macos.ts` fresh per
test, since `mock.module` and the module-level `terminalNotifierPath` cache would
otherwise leak between tests in this same file — verify this actually works against
this repo's pinned Bun version in Step 4; if `mock.module` re-application doesn't
re-run module-level code even with a differing specifier, restructure
`resolveTerminalNotifier`'s cache to be resettable via an exported test-only function
instead, and say so in your report.)

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/notify/macos.test.ts`
Expected: FAIL — `Cannot find module '../../src/notify/macos.js'` (doesn't exist yet).

- [ ] **Step 3: Implement `src/notify/macos.ts`**

```ts
import { execFileSync } from 'node:child_process';

let terminalNotifierPath: string | undefined | null = null; // null = not yet checked

/** Resolved once per daemon process — matches this daemon's other process-lifetime caches (e.g. SessionRuntime's `starting` set). */
function resolveTerminalNotifier(): string | undefined {
  if (terminalNotifierPath !== null) return terminalNotifierPath ?? undefined;
  try {
    terminalNotifierPath = execFileSync('which', ['terminal-notifier'], { encoding: 'utf8' }).trim();
  } catch {
    terminalNotifierPath = undefined;
  }
  return terminalNotifierPath ?? undefined;
}

/**
 * Opens Terminal.app running `command` — not the user's actual preferred terminal
 * (iTerm2, kitty, etc.) if different, a known limitation (design doc §6). Built as an
 * AppleScript `do script` argument, itself one argv element to `osascript` — never a
 * hand-concatenated shell string (CLAUDE.md §5). `JSON.stringify` on the joined
 * command produces a valid double-quoted AppleScript string literal for any input
 * (AppleScript and JSON happen to share `"`/`\` escaping rules for a plain string),
 * closing the injection surface a naive `"..."` wrap would leave open for a
 * path/symbol containing a literal `"`.
 */
function openTerminalScript(command: string[]): string {
  const shellCommand = command.map((c) => `'${c.replace(/'/g, "'\\''")}'`).join(' ');
  return `tell application "Terminal" to do script ${JSON.stringify(shellCommand)}\ntell application "Terminal" to activate`;
}

export function sendMacNotification(title: string, message: string, clickCommand: string[] | undefined): void {
  const tn = resolveTerminalNotifier();
  if (tn !== undefined) {
    const args = ['-title', title, '-message', message];
    if (clickCommand !== undefined) {
      args.push('-execute', `osascript -e ${JSON.stringify(openTerminalScript(clickCommand))}`);
    }
    execFileSync(tn, args, { stdio: 'ignore' });
    return;
  }
  // No click-through without terminal-notifier (design doc §3.2) — `display
  // notification` has no action mechanism at all.
  execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], {
    stdio: 'ignore',
  });
}

/** darwin only — every other platform gets a silent no-op (design doc §3.4, §1 non-goals). */
export function platformSend(): (title: string, message: string, clickCommand: string[] | undefined) => void {
  return process.platform === 'darwin' ? sendMacNotification : () => {};
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/notify/macos.test.ts`
Expected: all PASS. If `mock.module`'s per-file caching doesn't isolate cleanly across
the test cases in this file (see Step 1's note), restructure as described there —
this is a known Bun-mocking nuance, not a design problem, and worth flagging in your
report either way.

- [ ] **Step 5: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/notify/macos.ts tests/notify/macos.test.ts
git commit -m "feat(notify): sendMacNotification — terminal-notifier click-through, osascript fallback

Argv-array construction throughout, never a concatenated shell/
AppleScript string (path/symbol values from Radar can contain
arbitrary characters). platformSend() gates the whole mechanism to
darwin; every other platform gets a silent no-op, per design doc
§3.4/§1 non-goals — no code in this repo unit-tests a real OS
notification banner, matching ClaudePtyAdapter's PTY spawn and
RadarWatcherRegistry's fs.watch precedent."
```

---

### Task 4: `config.setNotify` RPC + `cw config notify on/off [--event]` CLI

**Files:**
- Modify: `src/daemon/methods.ts`
- Modify: `src/cli/commands/config.ts`
- Create: `tests/daemon/methods-notify-config.test.ts`
- Modify: `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `NotifyConfigRepo` (Task 1, `src/db/repositories/notify-config.js`).
- Produces: RPC `'config.setNotify'` (params `{ workspaceId: string; enabled?:
  boolean; event?: NotifyEventKind }` — `event` present sets that one column,
  `event` absent sets the master switch; returns the resulting `NotifyConfigRow`-shaped
  object). `'config.status'` gains a `notify` field in its response, reading through
  the same repo. `cw config notify on|off [--event collision|blocked|land|convergence]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/daemon/methods-notify-config.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

function seed() {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T2',
  });
  return db;
}

const ctx = { notify: () => undefined, onClose: () => undefined };

describe('config.setNotify RPC', () => {
  test('no event: sets the master enabled switch', async () => {
    const db = seed();
    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['config.setNotify']!({ workspaceId: 'ws_1', enabled: false }, ctx)) as { enabled: boolean };
    expect(result.enabled).toBe(false);
  });

  test('with event: sets exactly that column, leaves enabled and the others alone', async () => {
    const db = seed();
    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['config.setNotify']!(
      { workspaceId: 'ws_1', event: 'collision', enabled: false }, ctx,
    )) as { enabled: boolean; collision: boolean; blocked: boolean };
    expect(result.collision).toBe(false);
    expect(result.enabled).toBe(true);
    expect(result.blocked).toBe(true);
  });
});

describe('config.status RPC: notify section', () => {
  test('reports every default true when nothing has been toggled', async () => {
    const db = seed();
    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['config.status']!({ workspaceId: 'ws_1' }, ctx)) as {
      notify: { enabled: boolean; collision: boolean; blocked: boolean; land: boolean; convergence: boolean };
    };
    expect(result.notify).toEqual({ enabled: true, collision: true, blocked: true, land: true, convergence: true });
  });

  test('reflects a prior config.setNotify call', async () => {
    const db = seed();
    const methods = buildMethods(db, '/tmp/w');
    await methods['config.setNotify']!({ workspaceId: 'ws_1', event: 'land', enabled: false }, ctx);
    const result = (await methods['config.status']!({ workspaceId: 'ws_1' }, ctx)) as {
      notify: { land: boolean };
    };
    expect(result.notify.land).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/daemon/methods-notify-config.test.ts`
Expected: FAIL — `methods['config.setNotify']` is `undefined`; `result.notify` is
`undefined` on the existing `config.status` response shape.

- [ ] **Step 3: Implement the RPC handlers**

In `src/daemon/methods.ts`, add this import alongside the others:

```ts
import { NotifyConfigRepo, type NotifyEventKind } from '../db/repositories/notify-config.js';
```

Find (near the other repo constructions, right after `const configTrust = new ConfigTrustRepo(db);`):

```ts
  const configTrust = new ConfigTrustRepo(db);
```

Replace with:

```ts
  const configTrust = new ConfigTrustRepo(db);
  const notifyConfig = new NotifyConfigRepo(db);
```

Add a small param helper next to `optionalNum`:

```ts
function optionalEventKind(params: Record<string, unknown>, key: string): NotifyEventKind | undefined {
  const v = params[key];
  if (v === 'collision' || v === 'blocked' || v === 'land' || v === 'convergence') return v;
  return undefined;
}
```

Find the `'config.status'` handler:

```ts
    'config.status': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const testCommand = config.converge.testCommand;
      const trusted = testCommand !== undefined && isTestCommandTrusted(testCommand, configTrust, workspaceId);
      return { testCommand: testCommand ?? null, trusted };
    },
```

Replace with:

```ts
    'config.status': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const testCommand = config.converge.testCommand;
      const trusted = testCommand !== undefined && isTestCommandTrusted(testCommand, configTrust, workspaceId);
      const n = notifyConfig.get(workspaceId);
      // Explicit field list rather than spreading `n` directly, so the shape is
      // identical whether or not a row exists yet — `n` also carries `workspaceId`,
      // which the CLI/client side has no use for and shouldn't have to ignore.
      return {
        testCommand: testCommand ?? null,
        trusted,
        notify: {
          enabled: n?.enabled ?? true,
          collision: n?.collision ?? true,
          blocked: n?.blocked ?? true,
          land: n?.land ?? true,
          convergence: n?.convergence ?? true,
        },
      };
    },

    'config.setNotify': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const event = optionalEventKind(p, 'event');
      const enabled = bool(p, 'enabled', true);
      if (event === undefined) {
        notifyConfig.setEnabled(workspaceId, enabled);
      } else {
        notifyConfig.setEvent(workspaceId, event, enabled);
      }
      return notifyConfig.get(workspaceId) ?? { workspaceId, enabled: true, collision: true, blocked: true, land: true, convergence: true };
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/daemon/methods-notify-config.test.ts`
Expected: all PASS.

- [ ] **Step 5: Implement the CLI subcommand**

In `src/cli/commands/config.ts`, find:

```ts
import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';

interface TrustResult { trusted: boolean; testCommand: string }
interface StatusResult { testCommand: string | null; trusted: boolean }
```

Replace with:

```ts
import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';

interface TrustResult { trusted: boolean; testCommand: string }
interface NotifyStatus { enabled: boolean; collision: boolean; blocked: boolean; land: boolean; convergence: boolean }
interface StatusResult { testCommand: string | null; trusted: boolean; notify: NotifyStatus }

const NOTIFY_EVENTS = ['collision', 'blocked', 'land', 'convergence'] as const;
type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

function parseNotifyEvent(raw: string | undefined): NotifyEvent | undefined {
  if (raw === undefined) return undefined;
  if ((NOTIFY_EVENTS as readonly string[]).includes(raw)) return raw as NotifyEvent;
  throw new CrossweaveError('INVALID_ARGUMENTS', `--event must be one of ${NOTIFY_EVENTS.join(', ')}, got: ${raw}`);
}
```

Find the closing of `statusCommand` and the `configCommand` export:

```ts
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show whether converge.testCommand is trusted' },
  async run() {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const result = await client.call<StatusResult>('config.status', { workspaceId });
        if (result.testCommand === null) {
          process.stdout.write('converge.testCommand is not set\n');
          return;
        }
        process.stdout.write(`converge.testCommand: ${result.testCommand} (${result.trusted ? 'trusted' : 'NOT trusted'})\n`);
      });
    } catch (err) { fail(err); }
  },
});

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Manage crossweave.config.json trust' },
  subCommands: { trust: trustCommand, untrust: untrustCommand, status: statusCommand },
});
```

Replace with:

```ts
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show whether converge.testCommand is trusted, and notify preferences' },
  async run() {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const result = await client.call<StatusResult>('config.status', { workspaceId });
        if (result.testCommand === null) {
          process.stdout.write('converge.testCommand is not set\n');
        } else {
          process.stdout.write(`converge.testCommand: ${result.testCommand} (${result.trusted ? 'trusted' : 'NOT trusted'})\n`);
        }
        const n = result.notify;
        process.stdout.write(
          `notify: ${n.enabled ? 'on' : 'off'}\t` +
            `collision=${n.collision ? 'on' : 'off'}\tblocked=${n.blocked ? 'on' : 'off'}\t` +
            `land=${n.land ? 'on' : 'off'}\tconvergence=${n.convergence ? 'on' : 'off'}\n`,
        );
      });
    } catch (err) { fail(err); }
  },
});

const notifyCommand = defineCommand({
  meta: { name: 'notify', description: 'Enable or disable push notifications, overall or per event' },
  subCommands: {
    on: defineCommand({
      meta: { name: 'on', description: 'Enable push notifications' },
      args: { event: { type: 'string', description: 'collision|blocked|land|convergence — omit to set the master switch' } },
      async run({ args }) {
        try {
          const event = parseNotifyEvent(args.event);
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            await client.call('config.setNotify', { workspaceId, event, enabled: true });
            process.stdout.write(`notify ${event ?? ''} on\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
    off: defineCommand({
      meta: { name: 'off', description: 'Disable push notifications' },
      args: { event: { type: 'string', description: 'collision|blocked|land|convergence — omit to set the master switch' } },
      async run({ args }) {
        try {
          const event = parseNotifyEvent(args.event);
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            await client.call('config.setNotify', { workspaceId, event, enabled: false });
            process.stdout.write(`notify ${event ?? ''} off\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
  },
});

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Manage crossweave.config.json trust and notify preferences' },
  subCommands: { trust: trustCommand, untrust: untrustCommand, status: statusCommand, notify: notifyCommand },
});
```

- [ ] **Step 6: Write the e2e round-trip test**

In `tests/cli/cli.test.ts`, find:

```ts
  it('workspace safe-mode shows and sets the tier, including T1', async () => {
```

Add this test right before it:

```ts
  it('cw config notify on/off round-trips through config status, overall and per-event', async () => {
    await cw(['init']);
    const initialStatus = await cw(['config', 'status']);
    expect(initialStatus.stdout).toContain('notify: on');
    expect(initialStatus.stdout).toContain('collision=on');

    const offAll = await cw(['config', 'notify', 'off']);
    expect(offAll.exitCode).toBe(0);
    expect((await cw(['config', 'status'])).stdout).toContain('notify: off');

    const onAll = await cw(['config', 'notify', 'on']);
    expect(onAll.exitCode).toBe(0);
    expect((await cw(['config', 'status'])).stdout).toContain('notify: on');

    const offOneEvent = await cw(['config', 'notify', 'off', '--event', 'collision']);
    expect(offOneEvent.exitCode).toBe(0);
    const status = await cw(['config', 'status']);
    expect(status.stdout).toContain('collision=off');
    expect(status.stdout).toContain('blocked=on'); // untouched
  }, 30_000);

  it('rejects an invalid --event value', async () => {
    await cw(['init']);
    const r = await cw(['config', 'notify', 'off', '--event', 'bogus']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('INVALID_ARGUMENTS:');
  }, 30_000);

```

- [ ] **Step 7: Run to verify everything passes**

Run: `bun test tests/daemon/methods-notify-config.test.ts tests/cli/cli.test.ts`
Expected: all PASS.

- [ ] **Step 8: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 9: Commit**

```bash
git add src/daemon/methods.ts src/cli/commands/config.ts \
  tests/daemon/methods-notify-config.test.ts tests/cli/cli.test.ts
git commit -m "feat(config): config.setNotify RPC, cw config notify on/off [--event]

Mirrors cw config trust/untrust's existing shape. Reads/writes
notify_config live through the daemon, so a toggle takes effect on
the next event with no restart needed."
```

---

### Task 5: Wire the background collision path — shared gate injection, `notifyCollisions`

Makes the background `fs.watch`-driven collision path fire a desktop notification, and
sets up the ONE shared `NotificationGate`/`NotifyDispatcherDeps` construction in
`buildMethods` that every later task's call site reuses.

**Files:**
- Modify: `src/radar/retro-notify.ts`
- Modify: `src/daemon/watcher.ts`
- Modify: `src/daemon/methods.ts`
- Modify: `tests/radar/retro-notify.test.ts`

**Interfaces:**
- Consumes: `notify`/`NotifyDispatcherDeps` (Task 2), `platformSend` (Task 3),
  `NotifyConfigRepo` (Task 1).
- Produces: `RadarWatcherRegistry`'s constructor gains an injected `gate:
  NotificationGate` parameter (defaults to `new NotificationGate()` — every existing
  test that constructs it with 3 args keeps working unchanged). `buildMethods`
  constructs `const notifyGate = new NotificationGate();` and `const notifyDeps:
  NotifyDispatcherDeps = { gate: notifyGate, isEnabled: ..., send: platformSend() };` —
  every later task (6-9) reuses this exact `notifyDeps` binding.

- [ ] **Step 1: Write the failing test**

In `tests/radar/retro-notify.test.ts`, find the imports:

```ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { MessageBus } from '../../src/domain/bus.js';
import { SessionManager } from '../../src/domain/session.js';
import { NotificationGate } from '../../src/radar/noise.js';
import { notifyCollisions } from '../../src/radar/retro-notify.js';
```

Replace with:

```ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { MessageBus } from '../../src/domain/bus.js';
import { SessionManager } from '../../src/domain/session.js';
import { NotificationGate } from '../../src/radar/noise.js';
import { notifyCollisions } from '../../src/radar/retro-notify.js';
import type { NotifyDispatcherDeps } from '../../src/notify/dispatcher.js';
```

Add this test inside `describe('notifyCollisions', ...)`, after the existing
`'the rate-limit gate suppresses a repeat call for the same collision'` test:

```ts

  test('a collision also fires a desktop notification, sharing the SAME gate the advisory message used', () => {
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
    const sent: string[] = [];
    const notifyDeps: NotifyDispatcherDeps = {
      gate, isEnabled: () => true,
      send: (_title, message) => { sent.push(message); },
    };

    notifyCollisions(claims, bus, gate, { workspaceId: 'ws_1', sessionId: 's_1' }, notifyDeps);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('src/x.ts');
    // The advisory bus message ALSO went out — proving both piggyback on the same
    // single gate.shouldNotify call, not two independent throttles.
    expect(bus.inbox('ws_1', 's_2')).toHaveLength(1);
  });

  test('a second call within the gate window sends neither the advisory message nor a second notification', () => {
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
    const sent: string[] = [];
    const notifyDeps: NotifyDispatcherDeps = { gate, isEnabled: () => true, send: (_t, m) => { sent.push(m); } };

    notifyCollisions(claims, bus, gate, { workspaceId: 'ws_1', sessionId: 's_1' }, notifyDeps);
    notifyCollisions(claims, bus, gate, { workspaceId: 'ws_1', sessionId: 's_1' }, notifyDeps);

    expect(sent).toHaveLength(1);
    expect(bus.inbox('ws_1', 's_2')).toHaveLength(1);
  });
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/radar/retro-notify.test.ts`
Expected: FAIL — `notifyCollisions` currently takes 4 arguments, the new tests pass 5;
TS also flags the extra argument.

- [ ] **Step 3: Implement it**

In `src/radar/retro-notify.ts`, find:

```ts
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

Replace with:

```ts
import type { FileClaimRepo } from '../db/repositories/file-claim.js';
import type { MessageBus } from '../domain/bus.js';
import { checkCollisions } from './collisions.js';
import type { NotificationGate } from './noise.js';
import { notify, type NotifyDispatcherDeps } from '../notify/dispatcher.js';

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
 *
 * M6b: the desktop notification piggybacks on the SAME `gate.shouldNotify`
 * call the advisory bus message already gated on — deliberately not a second,
 * separate gate check (design doc §3.1), so shipping M6b does not silently
 * halve this path's existing advisory-message budget.
 */
export function notifyCollisions(
  claims: FileClaimRepo,
  bus: MessageBus,
  gate: NotificationGate,
  opts: RetroNotifyOpts,
  notifyDeps: NotifyDispatcherDeps,
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
      notify(notifyDeps, {
        kind: 'collision', sessionA: opts.sessionId, sessionB: collision.sessionId,
        path: collision.path, symbol: collision.symbol, workspaceId: opts.workspaceId,
      });
    }
  }
}
```

- [ ] **Step 4: Update `RadarWatcherRegistry` to accept and thread the shared gate + notifyDeps**

In `src/daemon/watcher.ts`, find:

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
```

Replace with:

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
import type { NotifyDispatcherDeps } from '../notify/dispatcher.js';
```

Find:

```ts
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
```

Replace with:

```ts
export class RadarWatcherRegistry {
  private readonly indexer: RadarIndexer;
  private readonly claims: FileClaimRepo;
  private readonly watchers = new Map<string, { fsWatcher: FSWatcher; debouncer: ReturnType<typeof createDebouncer> }>();

  constructor(
    db: Database,
    private readonly bus: MessageBus,
    private readonly contracts: ContractService,
    // M6b: injected rather than owned, so buildMethods can hand this same instance
    // to radar.check's RPC handler too — one real gate for both the background and
    // live-hook collision-detection paths, not two separate ones that could
    // double-notify the same collision (design doc §3.1's correction note).
    private readonly gate: NotificationGate = new NotificationGate(),
    private readonly notifyDeps: NotifyDispatcherDeps = { gate, isEnabled: () => true, send: () => {} },
  ) {
    this.indexer = new RadarIndexer(db);
    this.claims = new FileClaimRepo(db);
  }
```

Find:

```ts
  private async reindexAndNotify(session: IndexableSession): Promise<void> {
    await this.indexer.reindexSession(session);
    notifyCollisions(this.claims, this.bus, this.gate, {
      workspaceId: session.workspaceId, sessionId: session.id,
    });
```

Replace with:

```ts
  private async reindexAndNotify(session: IndexableSession): Promise<void> {
    await this.indexer.reindexSession(session);
    notifyCollisions(
      this.claims, this.bus, this.gate,
      { workspaceId: session.workspaceId, sessionId: session.id },
      this.notifyDeps,
    );
```

- [ ] **Step 5: Wire `buildMethods`'s shared gate/notifyDeps construction**

In `src/daemon/methods.ts`, add these imports alongside the others:

```ts
import { NotificationGate } from '../radar/noise.js';
import { notify, type NotifyDispatcherDeps } from '../notify/dispatcher.js';
import { platformSend } from '../notify/macos.js';
```

Find:

```ts
  const contracts = new ContractService(db);
  const radarWatchers = new RadarWatcherRegistry(db, bus, contracts);
  const configTrust = new ConfigTrustRepo(db);
  const notifyConfig = new NotifyConfigRepo(db);
```

Replace with:

```ts
  const contracts = new ContractService(db);
  // Constructed here, once, and threaded into both collision-detection paths
  // (RadarWatcherRegistry below, and radar.check's own handler further down) so a
  // collision either path notices shares exactly one throttle budget — see
  // src/radar/retro-notify.ts's own doc comment and design doc §3.1's correction.
  const notifyGate = new NotificationGate();
  const configTrust = new ConfigTrustRepo(db);
  const notifyConfig = new NotifyConfigRepo(db);
  const notifyDeps: NotifyDispatcherDeps = {
    gate: notifyGate,
    isEnabled: (workspaceId, kind) => notifyConfig.isEnabled(workspaceId, kind),
    send: platformSend(),
  };
  const radarWatchers = new RadarWatcherRegistry(db, bus, contracts, notifyGate, notifyDeps);
```

(This moves `radarWatchers`'s construction to AFTER `notifyGate`/`notifyDeps` exist,
which it must be — confirm no other code between the original `const contracts = ...`
line and the original `const radarWatchers = ...` line was skipped; if the real file
has additional lines in between by the time you implement this, preserve them in
their original relative order around this edit.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/radar/retro-notify.test.ts tests/daemon`
Expected: all PASS.

- [ ] **Step 7: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 8: Commit**

```bash
git add src/radar/retro-notify.ts src/daemon/watcher.ts src/daemon/methods.ts tests/radar/retro-notify.test.ts
git commit -m "feat(notify): wire the background collision path to notify(), share one gate

RadarWatcherRegistry's NotificationGate is now injected, not owned,
so buildMethods can hand the SAME instance to radar.check's RPC
handler in a later task -- one real throttle budget for both
collision-detection paths, not two separate persistent-but-distinct
ones that could double-notify the same collision."
```

---

### Task 6: Wire `radar.check` — live-hook collision + blocked events

**Files:**
- Modify: `src/daemon/methods.ts`
- Modify: `tests/daemon/methods-radar.test.ts`

**Interfaces:**
- Consumes: `notify`/`notifyDeps` (Task 5's `buildMethods`-scoped binding).
- Produces: `'radar.check'`'s handler now fires `notify(notifyDeps, { kind: 'blocked',
  ... })` once when `blocked === true`, and `notify(notifyDeps, { kind: 'collision',
  ... })` once per entry in `collisions`.

- [ ] **Step 1: Write the failing test**

In `tests/daemon/methods-radar.test.ts`, find:

```ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';

describe('radar.check RPC', () => {
  test('reports a collision written directly to file_claim', async () => {
```

Replace with:

```ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';

const ctx = { notify: () => undefined, onClose: () => undefined };

describe('radar.check RPC', () => {
  test('reports a collision written directly to file_claim', async () => {
```

Add these tests at the end of the `describe('radar.check RPC', ...)` block, right
before its closing `});`:

```ts

  test('a blocked write fires a "blocked" desktop notification', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
    const sessions = new SessionRepo(db);
    for (const [id, tier] of [['s_1', 'T2'], ['s_2', 'T2']] as const) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
        enforcementTier: tier, pid: null,
      });
    }
    new FileClaimRepo(db).upsert({
      id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });

    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' }, ctx,
    )) as { blocked: boolean };
    expect(result.blocked).toBe(true);
    // No injected notifyDeps at this layer (buildMethods constructs its own
    // real one) — this test only proves the RPC still returns the correct
    // blocked verdict with the notify() call wired in; Task 5/6's own
    // dispatcher-level and retro-notify-level tests cover notify()'s actual
    // send behavior with an injectable fake. A real send() would try
    // osascript/terminal-notifier here, which is undesirable in a unit test —
    // see the design doc §5 note on why sendMacNotification is never
    // exercised this way.
  });
});
```

(The last test intentionally does NOT assert on notification content — `buildMethods`
constructs its own real `platformSend()`-backed `send`, and this test file has no seam
to inject a fake one without changing `buildMethods`'s public signature, which is out
of scope here. It exists to prove the wiring doesn't crash or change `radar.check`'s
own return contract, not to test `notify()`'s internals — those are already covered
by Task 2's dispatcher tests. If you find this test provides too little signal, note
that in your report rather than expanding `buildMethods`'s signature to fix it — that
is a larger decision than this task's scope.)

- [ ] **Step 2: Run to verify the expected failure**

Run: `bun test tests/daemon/methods-radar.test.ts`
Expected: PASS as written — this task's test only proves no crash, so it should
already pass once Step 3 below compiles; run it once now anyway to confirm today's
baseline (before Step 3's code change) still passes with the `blocked: true` assertion,
establishing the pre-change baseline.

- [ ] **Step 3: Implement it**

In `src/daemon/methods.ts`, find:

```ts
    'radar.check': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const sessionId = str(p, 'sessionId');
      const symbol = optionalStr(p, 'symbol');
      // Session NAMES are a display concern, added here where `sessions` is already in
      // scope, for the one consumer that needs a human-readable name: the hook's
      // advisory text. The blocking POLICY itself lives in decideBlocked, not here —
      // see its own doc comment for why (M5b's ACP permission handler needs the
      // identical decision, in-process, with no transport of its own).
      const { collisions, blocked } = decideBlocked(
        { fileClaims, workspaces, sessions },
        { workspaceId, sessionId, path: str(p, 'path'), symbol },
      );
      return {
        blocked,
        collisions: collisions.map((c) => ({
          ...c,
          sessionName: sessions.resolve(workspaceId, c.sessionId).name,
        })),
      };
    },
```

Replace with:

```ts
    'radar.check': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const sessionId = str(p, 'sessionId');
      const path = str(p, 'path');
      const symbol = optionalStr(p, 'symbol');
      // Session NAMES are a display concern, added here where `sessions` is already in
      // scope, for the one consumer that needs a human-readable name: the hook's
      // advisory text. The blocking POLICY itself lives in decideBlocked, not here —
      // see its own doc comment for why (M5b's ACP permission handler needs the
      // identical decision, in-process, with no transport of its own).
      const { collisions, blocked } = decideBlocked(
        { fileClaims, workspaces, sessions },
        { workspaceId, sessionId, path, symbol },
      );
      const querySessionName = sessions.resolve(workspaceId, sessionId).name;
      // M6b: this is the LIVE-hook collision path — deliberately not
      // radar-hook.ts, whose own gate is a fresh instance per subprocess and
      // provides no real cross-call throttling (design doc §3.1's correction
      // note). notifyGate is the SAME instance RadarWatcherRegistry's
      // background path uses, injected above.
      if (blocked) {
        notify(notifyDeps, { kind: 'blocked', session: querySessionName, path, symbol: symbol ?? null, workspaceId });
      }
      const collisionsWithNames = collisions.map((c) => ({
        ...c,
        sessionName: sessions.resolve(workspaceId, c.sessionId).name,
      }));
      for (const c of collisionsWithNames) {
        notify(notifyDeps, {
          kind: 'collision', sessionA: querySessionName, sessionB: c.sessionName,
          path: c.path, symbol: c.symbol, workspaceId,
        });
      }
      return { blocked, collisions: collisionsWithNames };
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/daemon/methods-radar.test.ts`
Expected: all PASS.

- [ ] **Step 5: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/methods.ts tests/daemon/methods-radar.test.ts
git commit -m "feat(notify): wire radar.check's live-hook path to blocked/collision notify()

Deliberately dispatched from the RPC handler (daemon-resident), not
radar-hook.ts (a fresh subprocess per PreToolUse call whose own gate
provides no real cross-call throttling) -- shares the SAME
NotificationGate RadarWatcherRegistry's background path uses."
```

---

### Task 7: Wire `land.session` — land ok/fail events

**Files:**
- Modify: `src/daemon/methods.ts`
- Modify: `tests/convergence/land.test.ts`

**Interfaces:**
- Consumes: `notify`/`notifyDeps` (Task 5).
- Produces: `'land.session'`'s handler fires `notify(notifyDeps, { kind: 'land', ok:
  true, ... })` on success and `notify(notifyDeps, { kind: 'land', ok: false, ... })`
  on failure, WITHOUT changing what the RPC itself returns or throws to its caller.

- [ ] **Step 1: Write the failing test**

In `tests/convergence/land.test.ts`, find the `describe('land.session RPC', ...)`
block's closing:

```ts
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 10_000);
});
```

Add these two tests right before that closing `});`:

```ts

  test('a successful land still returns the real LandResult unchanged, notify() wiring does not alter it', async () => {
    const fixture = await makeGitFixture();
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const methods = buildMethods(db, fixture.root);
      const ctx = { notify: () => undefined, onClose: () => undefined };

      const created = (await methods['session.new']!(
        { workspaceId: 'ws_1', name: 'a', agent: 'claude', worktree: true }, ctx,
      )) as { worktreePath: string };
      await commitFile(created.worktreePath, 'work.txt', 'work\n', 'agent commit');

      const result = (await methods['land.session']!({ workspaceId: 'ws_1', idOrName: 'a', force: false }, ctx)) as LandResult;
      expect(result.status).toBe('landed');
      expect(result.baseBranch).toBe('main');
    } finally {
      await fixture.cleanup();
    }
  }, 10_000);

  test('a failed land still throws the real error unchanged, notify() wiring does not swallow it', async () => {
    const fixture = await makeGitFixture();
    try {
      await commitFile(fixture.root, 'shared.txt', 'base\n', 'seed');
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'shared.txt', 'from a\n', 'a edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'shared.txt', 'from main\n', 'main edits shared too');

      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const sessions = new SessionRepo(db);
      insertSession(sessions, { id: 's_a', name: 'a', worktreePath: fixture.root, branch: 'cw/a' });
      const methods = buildMethods(db, fixture.root);
      const ctx = { notify: () => undefined, onClose: () => undefined };

      await expect(
        methods['land.session']!({ workspaceId: 'ws_1', idOrName: 'a', force: false }, ctx),
      ).rejects.toMatchObject({ code: 'LAND_CONFLICT' });
    } finally {
      await fixture.cleanup();
    }
  });
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/convergence/land.test.ts`
Expected: both new tests PASS as written (they assert the pre-existing contract, not
new behavior) — this establishes the baseline `land.session`'s current behavior before
Step 3's change, so a regression Step 3 might introduce (e.g. swallowing the real
error) would show up as a NEW failure after Step 3, not before. Run this once now to
confirm the baseline passes.

- [ ] **Step 3: Implement it**

In `src/daemon/methods.ts`, find:

```ts
    'land.session': async (p) => {
      const workspaceId = str(p, 'workspaceId');
      const target = sessions.resolve(workspaceId, str(p, 'idOrName'));
      const force = bool(p, 'force', false);
      // `landSession` only has raw `SessionRepo` access and cannot reach the running
      // agent process — stopping it here, before landing, is what makes `--force`
      // actually stop a live session rather than just release its leases out from
      // under it. `removeWorktree: false` leaves the worktree/branch intact for
      // `landSession` to land normally; the row becomes `dead`, so `landSession`'s
      // own `status === 'running'` refusal no longer applies, which is correct for a
      // forced land.
      if (force && target.status === 'running') {
        await sessions.kill(workspaceId, target.id, { removeWorktree: false });
      }
      return landSession(
        { db, projectRoot, sessions: sessionsRepo, leaseManager, ledger, config, configTrust },
        workspaceId, target.id, { force },
      );
    },
```

Replace with:

```ts
    'land.session': async (p) => {
      const workspaceId = str(p, 'workspaceId');
      const target = sessions.resolve(workspaceId, str(p, 'idOrName'));
      const force = bool(p, 'force', false);
      // `landSession` only has raw `SessionRepo` access and cannot reach the running
      // agent process — stopping it here, before landing, is what makes `--force`
      // actually stop a live session rather than just release its leases out from
      // under it. `removeWorktree: false` leaves the worktree/branch intact for
      // `landSession` to land normally; the row becomes `dead`, so `landSession`'s
      // own `status === 'running'` refusal no longer applies, which is correct for a
      // forced land.
      if (force && target.status === 'running') {
        await sessions.kill(workspaceId, target.id, { removeWorktree: false });
      }
      // notify() failing/throwing is already caught inside notify() itself (design
      // doc §3.5) — the try/catch here exists ONLY to observe landSession's own
      // outcome for the notification's content, and re-throws unconditionally so the
      // caller's real result/error is never altered by this wiring.
      try {
        const result = await landSession(
          { db, projectRoot, sessions: sessionsRepo, leaseManager, ledger, config, configTrust },
          workspaceId, target.id, { force },
        );
        notify(notifyDeps, { kind: 'land', session: target.name, ok: true, baseBranch: result.baseBranch, workspaceId });
        return result;
      } catch (err) {
        const reason = err instanceof CrossweaveError ? err.code : String(err);
        notify(notifyDeps, { kind: 'land', session: target.name, ok: false, reason, workspaceId });
        throw err;
      }
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/convergence/land.test.ts`
Expected: all PASS.

- [ ] **Step 5: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/methods.ts tests/convergence/land.test.ts
git commit -m "feat(notify): wire land.session to land ok/fail notify()

Wrapped in a try/catch that exists only to observe the outcome for
the notification's content -- re-throws unconditionally, so
notify()'s own internal error handling can never alter what
land.session actually returns or throws to its real caller."
```

---

### Task 8: Wire `AcpAdapter.decideRequestPermission` — T1 blocked event

**Files:**
- Modify: `src/adapters/acp.ts`
- Modify: `src/daemon/methods.ts`
- Modify: `tests/adapters/acp.test.ts`
- Modify: `tests/adapters/acp-integration.test.ts`
- Modify: `tests/adapters/registry.test.ts`

**Interfaces:**
- Consumes: `notify`/`NotifyEvent` (Task 2, `src/notify/dispatcher.js`).
- Produces: `AcpAdapterDeps` gains `notify(event: NotifyEvent): void`.
  `decideRequestPermission` calls it once, with `kind: 'blocked'`, exactly when it is
  about to return `'reject_once'` because `result.blocked` was genuinely `true` (NOT
  on the fail-closed error branches — a thrown `decideBlocked`, a missing session id,
  etc. are internal errors, not a "collision blocked" event, and firing a `blocked`
  notification for those would misrepresent what happened).

- [ ] **Step 1: Write the failing tests**

In `tests/adapters/acp.test.ts`, find:

```ts
import { AcpAdapter } from '../../src/adapters/acp.js';
import type { DecideBlockedParams, DecideBlockedResult } from '../../src/radar/decision.js';
import type { RecordUsageParams } from '../../src/domain/usage.js';
```

Replace with:

```ts
import { AcpAdapter } from '../../src/adapters/acp.js';
import type { DecideBlockedParams, DecideBlockedResult } from '../../src/radar/decision.js';
import type { RecordUsageParams } from '../../src/domain/usage.js';
import type { NotifyEvent } from '../../src/notify/dispatcher.js';
```

Widen every existing `AcpAdapterDeps` literal in this file with a no-op `notify` —
every one shares the exact substring `recordUsage: () => {}, decideBlocked` or
`recordUsage: (params) => { seen.push(params); }, decideBlocked` (from Task 5 of the
M6a plan's own sweep) immediately followed by `decideBlocked`, so a single sweep fixes
all of them:

Run:

```bash
sed -i '' "s/, decideBlocked/, notify: () => {}, decideBlocked/g" tests/adapters/acp.test.ts
```

(macOS/BSD `sed -i ''`. This also touches the `recordUsage: (params) => { seen.push(params); },
decideBlocked` occurrences inside the usage_update tests — check after running that
none of those tests' assertions on `seen` accidentally captured a `notify` call
instead of a `recordUsage` call; if the sed's substring matched somewhere unintended,
report it rather than leaving a broken test.)

Then add these tests inside `describe('AcpAdapter', ...)`, after the existing `'a
blocked decision with no reject option at all cancels rather than falling back to
allow'` test:

```ts
  it('a blocked permission decision fires a "blocked" notify event', async () => {
    const events: NotifyEvent[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: true }),
        recordUsage: () => {},
        notify: (event) => { events.push(event); },
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'blocked', session: 's_1' });
    proc.kill();
  });

  it('an allowed permission decision fires no notify event', async () => {
    const events: NotifyEvent[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: () => {},
        notify: (event) => { events.push(event); },
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(events).toHaveLength(0);
    proc.kill();
  });

  it('a fail-closed internal error (decideBlocked throws) does NOT fire a "blocked" notify event — it is not a real collision block', async () => {
    const events: NotifyEvent[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => { throw new Error('simulated internal error'); },
        recordUsage: () => {},
        notify: (event) => { events.push(event); },
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject'); // still fails closed
    expect(events).toHaveLength(0); // but does not claim a collision-block happened
    proc.kill();
  });
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/adapters/acp.test.ts`
Expected: FAIL — `Property 'notify' is missing` (TS), plus the new behavioral
assertions failing since the adapter doesn't call `notify` yet.

- [ ] **Step 3: Implement it**

In `src/adapters/acp.ts`, find:

```ts
import type { DecideBlockedParams, DecideBlockedResult } from '../radar/decision.js';
import { CrossweaveError } from '../core/errors.js';
import type { RecordUsageParams } from '../domain/usage.js';
```

Replace with:

```ts
import type { DecideBlockedParams, DecideBlockedResult } from '../radar/decision.js';
import { CrossweaveError } from '../core/errors.js';
import type { RecordUsageParams } from '../domain/usage.js';
import type { NotifyEvent } from '../notify/dispatcher.js';
```

Find:

```ts
export interface AcpAdapterDeps {
  resolveWorkspaceId(sessionId: string): string;
  decideBlocked(params: DecideBlockedParams): DecideBlockedResult;
  recordUsage(params: RecordUsageParams): void;
}
```

Replace with:

```ts
export interface AcpAdapterDeps {
  resolveWorkspaceId(sessionId: string): string;
  decideBlocked(params: DecideBlockedParams): DecideBlockedResult;
  recordUsage(params: RecordUsageParams): void;
  notify(event: NotifyEvent): void;
}
```

Find the body of `decideRequestPermission`:

```ts
  try {
    const workspaceId = deps.resolveWorkspaceId(sessionId);
    const realCwd = realpathSync(cwd);
    for (const location of locations) {
      let relPath: string;
      try {
        relPath = relative(realCwd, assertContained(cwd, location.path));
      } catch (err) {
        // Only a genuine "outside the worktree" escape is skipped (matches the Claude
        // Code hook's precedent — that's not this adapter's problem to police). Any
        // OTHER failure (a symlink loop `assertContained` refuses to resolve, an
        // fs error) is NOT the same as "nothing to check" and must not be treated as
        // one — it denies, keeping this handler's fail-closed guarantee honest.
        if (err instanceof CrossweaveError && err.code === 'PATH_ESCAPE') continue;
        return 'reject_once';
      }
      const result = deps.decideBlocked({ workspaceId, sessionId, path: relPath });
      if (result.blocked) return 'reject_once';
    }
    return 'allow_once';
  } catch {
    return 'reject_once';
  }
}
```

Replace with:

```ts
  try {
    const workspaceId = deps.resolveWorkspaceId(sessionId);
    const realCwd = realpathSync(cwd);
    for (const location of locations) {
      let relPath: string;
      try {
        relPath = relative(realCwd, assertContained(cwd, location.path));
      } catch (err) {
        // Only a genuine "outside the worktree" escape is skipped (matches the Claude
        // Code hook's precedent — that's not this adapter's problem to police). Any
        // OTHER failure (a symlink loop `assertContained` refuses to resolve, an
        // fs error) is NOT the same as "nothing to check" and must not be treated as
        // one — it denies, keeping this handler's fail-closed guarantee honest.
        if (err instanceof CrossweaveError && err.code === 'PATH_ESCAPE') continue;
        return 'reject_once';
      }
      const result = deps.decideBlocked({ workspaceId, sessionId, path: relPath });
      if (result.blocked) {
        // Only the genuine "decideBlocked said blocked" case notifies — the
        // catch below (an internal error: resolveWorkspaceId/decideBlocked
        // throwing) also fails closed but is NOT a collision block, and firing
        // a "blocked" notification there would misreport what actually
        // happened (design doc §2 lists this as a policy decision, not an
        // error path).
        deps.notify({ kind: 'blocked', session: sessionId, path: relPath, symbol: null, workspaceId });
        return 'reject_once';
      }
    }
    return 'allow_once';
  } catch {
    return 'reject_once';
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/adapters/acp.test.ts`
Expected: all PASS.

- [ ] **Step 5: Fix the other two `AcpAdapterDeps` literals**

In `tests/adapters/registry.test.ts`, find:

```ts
  it('returns a cursor adapter with T1 when deps are provided', () => {
    const a = createAdapter('cursor', {
      resolveWorkspaceId: () => 'ws_1',
      decideBlocked: () => ({ collisions: [], blocked: false }),
      recordUsage: () => {},
    });
```

Replace with:

```ts
  it('returns a cursor adapter with T1 when deps are provided', () => {
    const a = createAdapter('cursor', {
      resolveWorkspaceId: () => 'ws_1',
      decideBlocked: () => ({ collisions: [], blocked: false }),
      recordUsage: () => {},
      notify: () => {},
    });
```

In `tests/adapters/acp-integration.test.ts`, find (this appears three times, verbatim,
per the M6a plan's own Task 5 — confirm the exact count in the real current file and
fix EVERY occurrence, not just the first):

```ts
      decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
      recordUsage: (params) => recordUsage({ sessions: sessionsRepo }, params),
    };
```

Replace **every occurrence** with:

```ts
      decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
      recordUsage: (params) => recordUsage({ sessions: sessionsRepo }, params),
      notify: () => {},
    };
```

(A no-op is correct here — this file's own tests assert on the permission
outcome/DB-row side effects, not on notify() firing; a dedicated notify-focused
integration test isn't needed since Task 6's acp.test.ts already covers that
behavior with an injectable fake, and this file's job — per its own doc comment — is
proving the REAL `decideBlocked`/`recordUsage` wiring, not every dependency.)

- [ ] **Step 6: Wire the real `notify` into `cursorDeps` in the daemon**

In `src/daemon/methods.ts`, find:

```ts
  const cursorDeps: AcpAdapterDeps = {
    resolveWorkspaceId: (sessionId) => {
      const row = sessionsRepo.findById(sessionId);
      if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
      return row.workspaceId;
    },
    decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
    recordUsage: (params) => recordUsage({ sessions: sessionsRepo }, params),
  };
```

Replace with:

```ts
  const cursorDeps: AcpAdapterDeps = {
    resolveWorkspaceId: (sessionId) => {
      const row = sessionsRepo.findById(sessionId);
      if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
      return row.workspaceId;
    },
    decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
    recordUsage: (params) => recordUsage({ sessions: sessionsRepo }, params),
    notify: (event) => notify(notifyDeps, event),
  };
```

`cursorDeps` is constructed BEFORE `notifyGate`/`notifyDeps` exist in the current file
(it comes early, right after `sessionsRepo`/`fileClaims`) — since `notifyDeps` is only
read INSIDE the arrow function passed as `notify:` here (not at construction time),
this is the same "closure captures a binding assigned later in the same function"
pattern `cursorDeps.decideBlocked`'s own closure over `sessions` already relies on
(that binding's own doc comment explains why it's sound); no reordering is needed as
long as `notifyDeps` is assigned somewhere earlier in `buildMethods`'s body than the
first RPC handler actually RUNS (Task 5 already placed it well before `return { ... }`).

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/acp.ts src/daemon/methods.ts tests/adapters/acp.test.ts \
  tests/adapters/acp-integration.test.ts tests/adapters/registry.test.ts
git commit -m "feat(notify): wire AcpAdapter's T1 permission decision to blocked notify()

Only the genuine decideBlocked-said-blocked case notifies -- the
fail-closed internal-error branches also reject_once but are not a
real collision block, and notifying there would misreport what
happened."
```

---

### Task 9: Wire `ConvergenceScheduler` — convergence event

**Files:**
- Modify: `src/daemon/convergence-scheduler.ts`
- Modify: `src/daemon/methods.ts`
- Modify: `tests/daemon/convergence-scheduler.test.ts`

**Interfaces:**
- Consumes: `notify`/`NotifyDispatcherDeps` (Task 2/5).
- Produces: `ConvergenceScheduler`'s constructor gains an injected `notifyDeps:
  NotifyDispatcherDeps` parameter (defaults to a no-op-send deps object, so every
  existing test constructing it with 5 args keeps working). A new private
  `recordTrial` method wraps all four existing `this.mergeTrials.insert(...)` call
  sites; for any 2-branch trial, it looks up that sorted branch-pair's prior result
  BEFORE inserting the new one, and fires `notify(..., { kind: 'convergence', ... })`
  when the result differs.

- [ ] **Step 1: Write the failing test**

In `tests/daemon/convergence-scheduler.test.ts`, find the imports:

```ts
import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { MergeTrialRepo } from '../../src/db/repositories/merge-trial.js';
import { ConfigTrustRepo } from '../../src/db/repositories/config-trust.js';
import { ConvergenceScheduler } from '../../src/daemon/convergence-scheduler.js';
import { hashTestCommand } from '../../src/convergence/trust.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';
```

Replace with:

```ts
import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { MergeTrialRepo } from '../../src/db/repositories/merge-trial.js';
import { ConfigTrustRepo } from '../../src/db/repositories/config-trust.js';
import { ConvergenceScheduler } from '../../src/daemon/convergence-scheduler.js';
import { hashTestCommand } from '../../src/convergence/trust.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';
import { NotificationGate } from '../../src/radar/noise.js';
import type { NotifyDispatcherDeps } from '../../src/notify/dispatcher.js';
```

Add this new `describe` block at the end of the file, after the existing
`describe('ConvergenceScheduler', ...)` block's closing `});`:

```ts

describe('ConvergenceScheduler: convergence notify', () => {
  // ConvergenceScheduler calls the real notify() (Task 2) with these deps —
  // notify()'s own dispatch logic is already covered by Task 2's own tests, so
  // what THIS file needs to prove is that `recordTrial` calls notify() with the
  // right event at all, which is observable through `send` actually firing.
  function captureSentMessages(): { deps: NotifyDispatcherDeps; messages: string[] } {
    const messages: string[] = [];
    return {
      messages,
      deps: { gate: new NotificationGate(), isEnabled: () => true, send: (_title, message) => { messages.push(message); } },
    };
  }

  test('a pairwise trial result changing from clean to conflict fires a convergence notify event', async () => {
    const fixture = await makeGitFixture();
    try {
      await commitFile(fixture.root, 'shared.txt', 'base\n', 'seed');
      // cw/a starts untouched relative to shared.txt; cw/b changes it. Merging the
      // two together has nothing to conflict over yet — first trial is 'clean'.
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await $`git checkout -q -b cw/b`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'shared.txt', 'from b\n', 'b edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const sessions = new SessionRepo(db);
      const config = { ...DEFAULT_CONFIG, converge: { ...DEFAULT_CONFIG.converge, trialDebounceMs: 0 } };
      const leaseManager = new LeaseManager(db, fixture.root, config);
      const configTrust = new ConfigTrustRepo(db);
      const { deps: notifyDeps, messages } = captureSentMessages();
      const scheduler = new ConvergenceScheduler(db, fixture.root, config, leaseManager, configTrust, notifyDeps);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'auth', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
      });
      sessions.insert({
        id: 's_b', workspaceId: 'ws_1', name: 'payments', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/b', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
      });

      await scheduler.tick();
      const firstPairwise = new MergeTrialRepo(db).listByWorkspace('ws_1').filter((t) => t.branches.length === 2);
      expect(firstPairwise).toHaveLength(1);
      expect(firstPairwise[0]?.result).toBe('clean');
      expect(messages).toHaveLength(0); // nothing to compare against on the first-ever trial

      // Now make cw/a ALSO touch shared.txt, diverging from cw/b's own edit —
      // merging the two together will now genuinely conflict. This changes cw/a's
      // head, which is what makes the next tick() re-trial this pair at all.
      await $`git checkout -q cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'shared.txt', 'from a\n', 'a also edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      await scheduler.tick();
      const secondPairwise = new MergeTrialRepo(db).listByWorkspace('ws_1').filter((t) => t.branches.length === 2);
      expect(secondPairwise).toHaveLength(2);
      expect(secondPairwise[1]?.result).toBe('conflict');

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('auth');
      expect(messages[0]).toContain('payments');
      expect(messages[0]).toContain('clean');
      expect(messages[0]).toContain('conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a full-integration trial (3+ branches) never fires a convergence notify event', async () => {
    const fixture = await makeGitFixture();
    try {
      await commitFile(fixture.root, 'base.txt', 'base\n', 'seed');
      for (const [branch, file] of [['cw/a', 'a.txt'], ['cw/b', 'b.txt'], ['cw/c', 'c.txt']] as const) {
        await $`git checkout -q -b ${branch}`.cwd(fixture.root).quiet();
        await commitFile(fixture.root, file, `${file}\n`, `add ${file}`);
        await $`git checkout -q main`.cwd(fixture.root).quiet();
      }

      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const sessions = new SessionRepo(db);
      // fullIntegrationIntervalMs: 0 makes maybeRunFullIntegration actually run on
      // this same tick, producing a 3-branch trial — the case under test.
      const config = {
        ...DEFAULT_CONFIG,
        converge: { ...DEFAULT_CONFIG.converge, trialDebounceMs: 0, fullIntegrationIntervalMs: 0 },
      };
      const leaseManager = new LeaseManager(db, fixture.root, config);
      const configTrust = new ConfigTrustRepo(db);
      const { deps: notifyDeps, messages } = captureSentMessages();
      const scheduler = new ConvergenceScheduler(db, fixture.root, config, leaseManager, configTrust, notifyDeps);
      let i = 0;
      for (const branch of ['cw/a', 'cw/b', 'cw/c']) {
        sessions.insert({
          id: `s_${i}`, workspaceId: 'ws_1', name: `s${i}`, agentKind: 'claude', adapter: 'claude',
          status: 'running', worktreePath: fixture.root, branch, createdAt: 'now',
          lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
        });
        i += 1;
      }

      await scheduler.tick();
      const fullIntegration = new MergeTrialRepo(db).listByWorkspace('ws_1').filter((t) => t.branches.length > 2);
      expect(fullIntegration).toHaveLength(1); // the 3-branch trial did run
      // The pairwise trials (a-b, a-c, b-c) are all 'clean' — none differ from a
      // prior trial either (all first-ever for their pair) — so `messages` must stay
      // empty regardless of the 3-branch trial's own result.
      expect(messages).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/daemon/convergence-scheduler.test.ts`
Expected: FAIL — `ConvergenceScheduler`'s constructor doesn't accept a 6th argument
yet (TS error), and/or the events array stays empty since nothing calls `notify` yet.

- [ ] **Step 3: Implement it**

In `src/daemon/convergence-scheduler.ts`, find:

```ts
import { ensureIntegrationWorktree, withIntegrationLease, withIntegrationWorktreeLock } from '../convergence/integration-worktree.js';
import { runMergeTrial, resetIntegration } from '../convergence/trial.js';
import { isTestCommandTrusted } from '../convergence/trust.js';
```

Replace with:

```ts
import { ensureIntegrationWorktree, withIntegrationLease, withIntegrationWorktreeLock } from '../convergence/integration-worktree.js';
import { runMergeTrial, resetIntegration } from '../convergence/trial.js';
import { isTestCommandTrusted } from '../convergence/trust.js';
import { notify, type NotifyDispatcherDeps } from '../notify/dispatcher.js';
import { NotificationGate } from '../radar/noise.js';
import type { MergeTrialRow } from '../db/repositories/merge-trial.js';
```

Find the constructor:

```ts
  constructor(
    private readonly db: Database,
    projectRoot: string,
    private readonly config: CrossweaveConfig,
    private readonly leaseManager: LeaseManager,
    private readonly configTrust: ConfigTrustRepo,
  ) {
    this.workspaces = new WorkspaceRepo(db);
    this.sessions = new SessionRepo(db);
    this.mergeTrials = new MergeTrialRepo(db);
  }
```

Replace with:

```ts
  constructor(
    private readonly db: Database,
    projectRoot: string,
    private readonly config: CrossweaveConfig,
    private readonly leaseManager: LeaseManager,
    private readonly configTrust: ConfigTrustRepo,
    // M6b: defaults to a real gate but a no-op send, so every existing 5-arg
    // construction (production and every prior test) keeps compiling and running
    // unchanged — only a caller that explicitly wants convergence notifications
    // needs to pass a real one.
    private readonly notifyDeps: NotifyDispatcherDeps = { gate: new NotificationGate(), isEnabled: () => true, send: () => {} },
  ) {
    this.workspaces = new WorkspaceRepo(db);
    this.sessions = new SessionRepo(db);
    this.mergeTrials = new MergeTrialRepo(db);
  }
```

Add a private helper method, placed right after the `private rememberPair(key: string): void { ... }` method:

```ts
  /**
   * Every `MergeTrialRepo.insert` in this class goes through here instead of
   * calling it directly (M6b) — the one place a pairwise (exactly 2 branches)
   * trial's result is compared against that same sorted pair's most recent
   * prior trial, firing a `convergence` notify event when it differs. A
   * full-integration trial (3+ branches) never compares or notifies — design
   * doc §2 scopes this event to pairwise trials only. The prior result is
   * looked up BEFORE inserting the new row, since inserting first would make
   * "most recent" trivially match the row just inserted.
   */
  private recordTrial(row: {
    id: string; workspaceId: string; ts: string; branches: string[];
    result: MergeTrialRow['result']; detail: string | null;
  }): void {
    let prior: MergeTrialRow['result'] | undefined;
    if (row.branches.length === 2) {
      const key = [...row.branches].sort().join('|');
      const existing = this.mergeTrials
        .listByWorkspace(row.workspaceId)
        .filter((t) => t.branches.length === 2 && [...t.branches].sort().join('|') === key);
      prior = existing.length > 0 ? existing[existing.length - 1]!.result : undefined;
    }

    this.mergeTrials.insert(row);

    if (row.branches.length === 2 && prior !== undefined && prior !== row.result) {
      const [branchA, branchB] = row.branches as [string, string];
      const active = this.activeBranchSessions(row.workspaceId);
      const sessionA = active.find((s) => s.branch === branchA)?.name ?? branchA;
      const sessionB = active.find((s) => s.branch === branchB)?.name ?? branchB;
      notify(this.notifyDeps, {
        kind: 'convergence', sessionA, sessionB, from: prior, to: row.result, workspaceId: row.workspaceId,
      });
    }
  }
```

Now replace all four `this.mergeTrials.insert(...)` call sites with `this.recordTrial(...)`.

Find (inside `tickWorkspace`'s pairwise loop):

```ts
            const result = await runMergeTrial(integration.path, base, [branchA, branchB]);
            resetIntegration(integration.path, base);
            this.mergeTrials.insert({
              id: newId('mt'), workspaceId, ts: new Date().toISOString(),
              branches: [branchA, branchB], result: result.result, detail: result.detail,
            });
            this.rememberPair(pairKey);
```

Replace with:

```ts
            const result = await runMergeTrial(integration.path, base, [branchA, branchB]);
            resetIntegration(integration.path, base);
            this.recordTrial({
              id: newId('mt'), workspaceId, ts: new Date().toISOString(),
              branches: [branchA, branchB], result: result.result, detail: result.detail,
            });
            this.rememberPair(pairKey);
```

Find (inside `maybeRunFullIntegration`, the conflict-result early return):

```ts
        const result = await runMergeTrial(integrationPath, base, branches);
        if (result.result === 'conflict') {
          this.mergeTrials.insert({
            id: newId('mt'), workspaceId, ts: new Date().toISOString(),
            branches, result: 'conflict', detail: result.detail,
          });
          return;
        }
```

Replace with:

```ts
        const result = await runMergeTrial(integrationPath, base, branches);
        if (result.result === 'conflict') {
          this.recordTrial({
            id: newId('mt'), workspaceId, ts: new Date().toISOString(),
            branches, result: 'conflict', detail: result.detail,
          });
          return;
        }
```

Find (no testCommand configured):

```ts
        const testCommand = this.config.converge.testCommand;
        if (testCommand === undefined) {
          this.mergeTrials.insert({
            id: newId('mt'), workspaceId, ts: new Date().toISOString(),
            branches, result: 'unverified', detail: null,
          });
          return;
        }
```

Replace with:

```ts
        const testCommand = this.config.converge.testCommand;
        if (testCommand === undefined) {
          this.recordTrial({
            id: newId('mt'), workspaceId, ts: new Date().toISOString(),
            branches, result: 'unverified', detail: null,
          });
          return;
        }
```

Find (testCommand not trusted):

```ts
        if (!isTestCommandTrusted(testCommand, this.configTrust, workspaceId)) {
          process.stderr.write(
            `crossweave: converge.testCommand is set but not trusted for workspace ${workspaceId} — run \`cw config trust\`. Skipping test run.\n`,
          );
          this.mergeTrials.insert({
            id: newId('mt'), workspaceId, ts: new Date().toISOString(),
            branches, result: 'unverified', detail: null,
          });
          return;
        }
```

Replace with:

```ts
        if (!isTestCommandTrusted(testCommand, this.configTrust, workspaceId)) {
          process.stderr.write(
            `crossweave: converge.testCommand is set but not trusted for workspace ${workspaceId} — run \`cw config trust\`. Skipping test run.\n`,
          );
          this.recordTrial({
            id: newId('mt'), workspaceId, ts: new Date().toISOString(),
            branches, result: 'unverified', detail: null,
          });
          return;
        }
```

Find (the final test-result insert):

```ts
        this.mergeTrials.insert({
          id: newId('mt'), workspaceId, ts: new Date().toISOString(),
          branches,
          result: testResult.code === 0 ? 'clean' : 'test_fail',
          detail: testResult.code === 0 ? null : testResult.tail,
        });
      } finally {
```

Replace with:

```ts
        this.recordTrial({
          id: newId('mt'), workspaceId, ts: new Date().toISOString(),
          branches,
          result: testResult.code === 0 ? 'clean' : 'test_fail',
          detail: testResult.code === 0 ? null : testResult.tail,
        });
      } finally {
```

Run `grep -n "this.mergeTrials.insert" src/daemon/convergence-scheduler.ts` after
these five edits and confirm ZERO matches remain — every insert now goes through
`recordTrial`.

- [ ] **Step 4: Wire the real `notifyDeps` into `buildMethods`'s `ConvergenceScheduler` construction**

In `src/daemon/methods.ts`, find:

```ts
  const convergenceScheduler = new ConvergenceScheduler(db, projectRoot, config, leaseManager, configTrust);
```

Replace with:

```ts
  const convergenceScheduler = new ConvergenceScheduler(db, projectRoot, config, leaseManager, configTrust, notifyDeps);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/daemon/convergence-scheduler.test.ts`
Expected: all PASS. If Step 1's tests needed adjustment to match this file's real
existing setup pattern (expected — that step deliberately left the exact seeding
calls for you to fill in from the real file), make sure the three tests still cover
exactly what their names say: a real state-change notifies once, a first-ever trial
does not notify, a full-integration (3+ branch) trial never notifies.

- [ ] **Step 6: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/convergence-scheduler.ts src/daemon/methods.ts tests/daemon/convergence-scheduler.test.ts
git commit -m "feat(notify): wire ConvergenceScheduler's pairwise trials to convergence notify()

recordTrial() wraps all four MergeTrialRepo.insert call sites,
looking up the prior result for a 2-branch pair BEFORE inserting the
new one so 'most recent prior trial' never trivially matches the row
just written. Full-integration trials (3+ branches) never compare or
notify, per design doc §2's pairwise-only scope."
```

---

### Task 10: M6b known-limitations doc, full verification, wrap-up

**Files:**
- Create: `docs/superpowers/specs/2026-08-14-m6b-known-limitations.md`

**Interfaces:** none.

- [ ] **Step 1: Write the known-limitations doc**

Create `docs/superpowers/specs/2026-08-14-m6b-known-limitations.md`:

```markdown
# crossweave M6b — known limitations

Accepted gaps carried out of M6b (push notifications), found and deliberately
deferred during implementation — see
`docs/superpowers/specs/2026-08-14-m6b-push-notification-design.md` for the full
design this summarizes.

## macOS only

No degrade-with-a-warning on Linux/Windows — `platformSend()` returns a silent no-op
on any platform other than `darwin`. The feature is simply absent there, not
implied to work everywhere.

## Click-through requires `terminal-notifier`, an optional external dependency

Without it installed (e.g. via Homebrew), notifications fall back to `osascript
display notification` — informational banners only, no click action at all.
`display notification` has no action mechanism in modern macOS regardless of whether
crossweave ships its own app bundle, which it deliberately does not (design doc §1
non-goals — building and code-signing one would violate this project's "zero native
dependencies" principle).

## Click-through always opens Terminal.app, never the user's actual preferred terminal

If a user's daily terminal is iTerm2, kitty, Ghostty, or anything else, clicking a
notification still opens (or activates) Apple's built-in Terminal.app. Not solved by
this milestone — flagged directly during brainstorming as a real, known gap.

## T1 (ACP) "blocked" notifications show the session id, not its friendly name

`AcpAdapterDeps` (`src/adapters/acp.ts`) deliberately carries minimal dependencies —
`resolveWorkspaceId`, `decideBlocked`, `recordUsage`, and now `notify` — none of which
resolve a session's display name. The T2 (Claude Code hook) `blocked` path, by
contrast, has `sessions.resolve(...).name` cheaply available in `radar.check`'s own
handler and uses it. Widening `AcpAdapterDeps` further just for a notification title's
cosmetic polish was judged not worth the interface churn (every existing
`AcpAdapterDeps` test literal across three files would need another field). A T1
blocked notification's session identifier is therefore the raw session id, not its
human-chosen name.

## `land`/`convergence` throttle coalesces per session (or per pair), not per distinct outcome

A session that lands successfully, is re-landed, and fails within the same
6-per-10-minute gate window only gets the first notification, not a correction — the
gate key is `(session, '__land__', null)`, not something that also encodes the
outcome. Acceptable for an at-a-glance signal; the real record of what actually
happened is the event ledger (`cw blame`), unaffected by this milestone. Same
reasoning applies to `convergence`, keyed by the sorted session pair only.

## No GUI session (headless/SSH) means notifications silently never arrive

`osascript`/`terminal-notifier` failing to reach Notification Center at all (no
logged-in local GUI session) is caught inside `notify()`, logged once per daemon
process lifetime, and never surfaced anywhere else. A user running crossweave's
daemon over SSH with no local GUI session gets no signal that notifications are
configured but structurally unable to arrive.

## `notify_config` is per-workspace, matching `config_trust` — not per-daemon or global

Multiple workspaces served by the same daemon each have their own independent notify
preference, exactly like `converge.testCommand` trust already works. Not a limitation
so much as a design choice worth stating plainly: `cw config notify off` in one
workspace does not silence another workspace's notifications.
```

- [ ] **Step 2: Full local gate**

```bash
bun run typecheck
bun test
```

Expected: `tsc --noEmit` reports 0 errors; `bun test` reports 0 fail. If you see a
stray-process-related failure (leftover `dist/cwd`/`src/daemon/main.ts` processes from
earlier test runs in this session — a known environment artifact documented in both
M5b's and M6a's own plans, not something this plan's changes cause), run `pgrep -fl
dist/cwd` and `pgrep -fl "src/daemon/main.ts"`, `kill -9` any stray PIDs found, and
re-run the suite once to confirm.

- [ ] **Step 3: Confirm the four insert call sites all route through `recordTrial`**

```bash
grep -n "this.mergeTrials.insert" src/daemon/convergence-scheduler.ts
```

Expected: no output. If anything matches, Task 9's Step 3 missed a call site — fix it
and re-run the full gate (Step 2 above).

- [ ] **Step 4: Confirm no OS notification was actually sent during the test run**

This project's design deliberately never unit-tests `sendMacNotification` by spawning
a real `osascript`/`terminal-notifier` process (design doc §5) — every test that
exercises `notify()`'s behavior injects a fake `send`. As a final sanity check (not an
automated test — this is a one-time manual confirmation, not part of the gate), if you
are running this verification step on an actual macOS machine with Notification Center
visible, confirm no crossweave banner appeared during the `bun test` run above. If one
did, some test is calling `platformSend()`'s real implementation instead of an
injected fake — find it and fix it before considering this task done.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-14-m6b-known-limitations.md
git commit -m "docs: record M6b's known limitations"
```

- [ ] **Step 6: Final report**

No further commits in this step. Report to the user: files changed, test count,
confirmation that `bun run typecheck` and `bun test` are both clean, and that the
branch is ready for review (not merged — merging requires the user's explicit
go-ahead per this project's standing rule).

---

## Deferred (explicitly out of scope, per the approved spec §7)

- Cross-platform support (Linux `notify-send`, Windows toast notifications).
- Any new transport: webhook, Slack, ntfy.sh, email.
- An internal daemon pub/sub event stream for M6c's TUI to subscribe to live — M6c's
  own problem if it turns out to need one.
- Notification history / a `cw notify log` command — the event ledger (`cw blame`)
  already covers forensics; this milestone's notifications are ephemeral,
  at-a-glance signals only.
