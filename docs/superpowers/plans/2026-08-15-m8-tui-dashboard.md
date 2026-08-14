# M8 TUI Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cw tui` — a live, push-updated, fully interactive dashboard:
session list, convergence matrix, radar feed, status bar; attach/land/
kill/gc/new-session without leaving it.

**Architecture:** Two new pieces — a daemon-side `BroadcastRegistry` (new
RPC `daemon.subscribe` + two broadcast message kinds) and a `cw tui`
process built on `@opentui/core` that holds one long-lived daemon
connection. Every interactive action calls an RPC that already exists.
Attach reuses the existing `cw session attach` command as a child process,
zero new PTY-relay code.

**Tech Stack:** `@opentui/core@0.5.3`, `@opentui/keymap@0.5.3` (new
runtime dependencies — verified current via the npm registry at plan-
writing time, re-verify before installing if this plan is executed later),
existing daemon/RPC/CLI infrastructure.

**Spec:** `docs/superpowers/specs/2026-08-15-m8-tui-design.md`

## Global Constraints

- `daemon.subscribe` and the broadcast registry add no new trust
  boundary — reachable by anyone who can already open the daemon's unix
  socket (design doc §5.2), same as every other RPC.
- `notify()` itself (`src/notify/dispatcher.ts`) is never modified — its
  "never throws" contract stays exactly as M6b/M7 left it. Broadcasting
  is a separate call, made alongside `notify()`, never inside it.
- `tui.invalidate` carries no payload — it is a coarse "re-fetch" signal
  only, not a typed event. Do not add fields to it; do not add new
  broadcast message kinds beyond `tui.event`/`tui.invalidate` without a
  documented reason (spec §3.2's explicit reasoning against a growing
  taxonomy).
- Destructive actions from the TUI (kill, gc) require an inline y/n
  confirmation before the RPC call — matches design doc §5.4's existing
  confirmation requirement for these operations everywhere else in the
  CLI.
- The TUI's daemon connection is long-lived for the process's entire
  lifetime — `cw tui` must NOT use `withClient` (`src/cli/context.ts`),
  which closes the connection immediately after one call. Connect via
  `connectOrStart` directly and close explicitly on quit.
- `@opentui/core`'s imperative API only (`BoxRenderable`, `TextRenderable`,
  `Select`, etc.) — no React or Solid bindings. Matches this project's
  existing zero-framework-dependency posture.
- Every new file's tests must be real (deterministic, no real network, no
  real daemon process spawned where a direct handler call or a fake
  suffices) — matches this project's established test discipline.

---

### Task 1: BroadcastRegistry

**Files:**
- Create: `src/daemon/broadcast.ts`
- Test: `tests/daemon/broadcast.test.ts`

**Interfaces:**
- Produces: `class BroadcastRegistry { subscribe(notify: (method: string, params: unknown) => void): () => void; broadcast(method: string, params: unknown): void }`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/daemon/broadcast.test.ts
import { describe, expect, test } from 'bun:test';
import { BroadcastRegistry } from '../../src/daemon/broadcast.js';

describe('BroadcastRegistry', () => {
  test('broadcast reaches every subscriber', () => {
    const registry = new BroadcastRegistry();
    const calls: Array<[string, unknown]> = [];
    registry.subscribe((m, p) => calls.push(['a', p]));
    registry.subscribe((m, p) => calls.push(['b', p]));
    registry.broadcast('tui.event', { kind: 'collision' });
    expect(calls).toEqual([
      ['a', { kind: 'collision' }],
      ['b', { kind: 'collision' }],
    ]);
  });

  test('broadcast with no subscribers does nothing (never throws)', () => {
    const registry = new BroadcastRegistry();
    expect(() => registry.broadcast('tui.invalidate', {})).not.toThrow();
  });

  test('unsubscribe stops delivery to that subscriber only', () => {
    const registry = new BroadcastRegistry();
    const calls: string[] = [];
    const unsubA = registry.subscribe(() => calls.push('a'));
    registry.subscribe(() => calls.push('b'));
    unsubA();
    registry.broadcast('tui.invalidate', {});
    expect(calls).toEqual(['b']);
  });

  test('calling the returned unsubscribe twice is a no-op, not an error', () => {
    const registry = new BroadcastRegistry();
    const unsub = registry.subscribe(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  test('the same subscriber function can be registered twice and each gets its own unsubscribe', () => {
    const registry = new BroadcastRegistry();
    const calls: number[] = [];
    const fn = () => calls.push(1);
    registry.subscribe(fn);
    const unsub2 = registry.subscribe(fn);
    unsub2();
    registry.broadcast('tui.invalidate', {});
    // Sets dedupe identical function references — registering the same fn twice and
    // unsubscribing one occurrence removes BOTH, since a Set can only hold it once.
    // This is a real, documented limitation of the Set-backed implementation, not a
    // test bug — assert the actual (documented) behavior.
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/daemon/broadcast.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/daemon/broadcast.ts`**

```typescript
/**
 * Lets any number of `daemon.subscribe`d connections (the TUI, today — nothing else)
 * receive events as they happen, instead of polling. Two message kinds only (spec
 * §3.2): `tui.event` (the full notify()-event payload, for the live radar feed) and
 * `tui.invalidate` (no payload — "something changed, re-fetch session.list/
 * converge.status/workspace.info"). Deliberately not a growing typed-event taxonomy.
 *
 * Backed by a Set, so the same function reference registered twice collapses to one
 * entry — call sites that need two independent subscriptions must pass two distinct
 * closures.
 */
export class BroadcastRegistry {
  private readonly subscribers = new Set<(method: string, params: unknown) => void>();

  subscribe(notify: (method: string, params: unknown) => void): () => void {
    this.subscribers.add(notify);
    return () => this.subscribers.delete(notify);
  }

  broadcast(method: string, params: unknown): void {
    for (const notify of this.subscribers) notify(method, params);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/daemon/broadcast.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/daemon/broadcast.ts tests/daemon/broadcast.test.ts
git commit -m "feat(tui): BroadcastRegistry — subscribe/broadcast for daemon.subscribe"
```

---

### Task 2: `daemon.subscribe` RPC + broadcast wiring

**Files:**
- Modify: `src/daemon/methods.ts`
- Test: `tests/daemon/methods-subscribe.test.ts` (new), extend
  `tests/daemon/methods-radar.test.ts`, `tests/convergence/land.test.ts`

**Interfaces:**
- Consumes: `BroadcastRegistry` from Task 1.
- Produces: RPC `daemon.subscribe` (no params, returns `{ subscribed: true }`);
  every `notify(notifyDeps, event)` call site also broadcasts `tui.event`
  with that same `event`; `session.new`, `session.kill`, `session.stop`,
  `session.rm`, `land.session` each broadcast `tui.invalidate` with `{}`
  on their success path (`land.session` broadcasts both — its own
  `tui.event` via the notify wrapper below, AND `tui.invalidate`).

**Context you need:** read `src/daemon/methods.ts`'s current
`buildMethods` in full before starting — this task touches many existing
handlers, each with its own established comment style; match it exactly,
don't just append code. `notifyGate`/`notifyDeps` are constructed once
near the top of `buildMethods`; construct `broadcastRegistry` the same way,
right alongside them:

```typescript
const broadcastRegistry = new BroadcastRegistry();
```

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/daemon/methods-subscribe.test.ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';

describe('daemon.subscribe', () => {
  test('returns { subscribed: true } and the connection starts receiving broadcasts', async () => {
    const db = openDatabase(':memory:');
    const notified: Array<[string, unknown]> = [];
    const methods = buildMethods(db, '/tmp/w');
    const ctx = {
      notify: (m: string, p: unknown) => notified.push([m, p]),
      onClose: () => undefined,
    };
    const result = await methods['daemon.subscribe']!({}, ctx);
    expect(result).toEqual({ subscribed: true });
  });
});
```

Add this new test to `tests/daemon/methods-radar.test.ts`, inside the
existing `describe('radar.check RPC', ...)` block, following that file's
established seed pattern exactly (read the file first — the two existing
tests in it already show the exact shape to copy):

```typescript
  test('a collision broadcasts tui.event to a subscribed connection', async () => {
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
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
      });
    }
    new FileClaimRepo(db).upsert({
      id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });

    const methods = buildMethods(db, '/tmp/w', undefined, undefined, { notifySend: () => {} });
    const broadcasts: Array<[string, unknown]> = [];
    const subscriberCtx = { notify: (m: string, p: unknown) => broadcasts.push([m, p]), onClose: () => undefined };
    await methods['daemon.subscribe']!({}, subscriberCtx);

    await methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' },
      ctx,
    );

    const tuiEvents = broadcasts.filter(([m]) => m === 'tui.event');
    expect(tuiEvents).toHaveLength(1);
    expect((tuiEvents[0]![1] as { kind: string }).kind).toBe('collision');
  });
```

This reuses the file's existing module-level `ctx` constant (already
defined at the top of the file, per its current content) for the
`radar.check` call itself, and a SEPARATE `subscriberCtx` standing in for
the TUI's own connection — the point being that a broadcast reaches a
DIFFERENT connection than the one that made the triggering call, which is
exactly what `daemon.subscribe` exists for.

Extend `tests/convergence/land.test.ts` similarly: after
`daemon.subscribe`, a successful `land.session` call must cause the
subscriber to receive a `'tui.invalidate'` broadcast (params `{}`) in
addition to whatever `tui.event`/notify behavior that test already covers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/daemon/methods-subscribe.test.ts`
Expected: FAIL — RPC does not exist yet.

- [ ] **Step 3: Add the RPC handler and broadcastRegistry construction**

Near the `notifyDeps` construction in `buildMethods`:

```typescript
const broadcastRegistry = new BroadcastRegistry();
```

In the RPC methods object (alongside `'daemon.shutdown'` or wherever
top-level daemon-scoped RPCs live):

```typescript
'daemon.subscribe': (_p, ctx) => {
  const unsubscribe = broadcastRegistry.subscribe(ctx.notify.bind(ctx));
  ctx.onClose(unsubscribe);
  return { subscribed: true };
},
```

Add the import: `import { BroadcastRegistry } from './broadcast.js';`

- [ ] **Step 4: Wire `tui.event` at every existing `notify()` call site**

Find every call site via `grep -n "notify(notifyDeps" src/daemon/methods.ts src/radar/retro-notify.ts src/daemon/convergence-scheduler.ts src/adapters/acp.ts` (5 sites, per M6b/M7's own history in this codebase — confirm the count matches what you find; if it doesn't, that's real information, not a reason to guess). At each one, add a broadcast call immediately after:

```typescript
notify(notifyDeps, event);
broadcastRegistry.broadcast('tui.event', event);
```

Three of these five call sites live in `src/daemon/methods.ts` itself,
where `broadcastRegistry` is already in scope. The other two
(`src/radar/retro-notify.ts`'s background collision path,
`src/daemon/convergence-scheduler.ts`'s `recordTrial`,
`src/adapters/acp.ts`'s blocked path) are in different files/classes —
thread `broadcastRegistry` into them the SAME way `notifyDeps` already
reaches them (as a constructor/function parameter), rather than
constructing a second instance. Read each file's existing
`notifyDeps`-threading pattern (constructor param with a safe default,
matching `NotificationGate`'s own established pattern in this codebase)
before adding `broadcastRegistry` alongside it — do not deviate from
that established shape.

- [ ] **Step 5: Wire `tui.invalidate` at the 5 state-changing RPC handlers**

`session.new`, `session.kill`, `session.rm` in `src/daemon/methods.ts`,
and `session.stop` (find its handler — it may be named differently;
search for the RPC method literally named `'session.stop'`), and
`land.session`'s handler. In each, after the existing success path
(after the row is returned / the RPC's existing `return`/response value
is determined, but the broadcast call itself doesn't affect what's
returned):

```typescript
broadcastRegistry.broadcast('tui.invalidate', {});
```

For `land.session` specifically: it already gets `tui.event` from Step 4
(since it already calls `notify()` for the `land` event kind) — add
`tui.invalidate` as an ADDITIONAL broadcast in the same success path, not
a replacement.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/daemon/methods-subscribe.test.ts tests/daemon/methods-radar.test.ts tests/convergence/land.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
bun run typecheck
bun test
git add src/daemon/methods.ts src/daemon/broadcast.ts src/radar/retro-notify.ts src/daemon/convergence-scheduler.ts src/adapters/acp.ts tests/daemon/methods-subscribe.test.ts tests/daemon/methods-radar.test.ts tests/convergence/land.test.ts
git commit -m "feat(tui): daemon.subscribe RPC + tui.event/tui.invalidate broadcast wiring"
```

---

### Task 3: `cw tui` command scaffold

**Files:**
- Create: `src/cli/commands/tui.ts`
- Modify: `src/cli/index.ts`
- Create: `package.json` (add `@opentui/core`, `@opentui/keymap` dependencies)

**Interfaces:**
- Consumes: `connectOrStart` from `src/client/rpc-client.js`,
  `currentWorkspaceId` pattern from `src/cli/context.js` (read it, but
  this command does NOT use `withClient` — Global Constraints).
- Produces: `cw tui` command, registered in `main`'s `subCommands`. A
  minimal renderer boot: connects, subscribes, does one initial
  `session.list`/`converge.status`/`workspace.info` fetch (stored in
  module state for later tasks to render), boots an OpenTUI renderer with
  an empty root box titled with the workspace name, and quits cleanly on
  `q` — no panes populated yet (Tasks 4-6 add those). This task's job is
  proving the connection/subscribe/renderer-lifecycle machinery works
  before building UI on top of it.

- [ ] **Step 1: Add the dependencies**

```bash
bun add @opentui/core@0.5.3 @opentui/keymap@0.5.3
```

Verify the exact installed versions in `package.json`/`bun.lock` match
what was requested — if `bun add` resolves to something newer (a new
version may have shipped since this plan was written), that's fine;
note it in your report rather than fighting it.

- [ ] **Step 2: Write `src/cli/commands/tui.ts`**

```typescript
import { defineCommand } from 'citty';
import { createCliRenderer, BoxRenderable, type CliRenderer } from '@opentui/core';
import { findProjectRoot } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { connectOrStart, type DaemonClient } from '../../client/rpc-client.js';
import { fail } from '../context.js';

interface WorkspaceInit { id: string; name: string }

export const tuiCommand = defineCommand({
  meta: { name: 'tui', description: 'Live dashboard — sessions, radar, convergence, budget' },
  async run() {
    // Deliberately NOT withClient (src/cli/context.ts) — that closes the connection
    // right after one call. This command holds one connection for its whole
    // lifetime, closing it only on quit. See plan Global Constraints.
    const projectRoot = findProjectRoot(process.cwd());
    loadConfig(projectRoot);
    let client: DaemonClient;
    try {
      client = await connectOrStart(projectRoot);
    } catch (err) {
      fail(err);
    }

    try {
      const ws = await client.call<WorkspaceInit>('workspace.init', {});
      await client.call('daemon.subscribe', {});

      const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });
      const root = new BoxRenderable(renderer, {
        id: 'root',
        width: '100%',
        height: '100%',
        borderStyle: 'rounded',
        title: `crossweave — ${ws.name}`,
        titleAlignment: 'left',
      });
      renderer.root.add(root);
      renderer.start();

      await new Promise<void>((resolve) => {
        renderer.keyInput.on('keypress', (key) => {
          if (key.name === 'q') {
            renderer.stop();
            resolve();
          }
        });
      });
    } finally {
      client.close();
    }
  },
});
```

Read `node_modules/@opentui/core`'s actual type definitions for
`createCliRenderer`'s options and `renderer.keyInput`'s `KeyEvent` shape
before finalizing this — the context7 doc snippets this plan was written
from are real but may not be 100% exhaustive; confirm `key.name` is
really the field carrying `'q'` for a plain q keypress, not `key.sequence`
or something else, against the actual installed package's types.

- [ ] **Step 3: Register the command**

In `src/cli/index.ts`: add `import { tuiCommand } from './commands/tui.js';`
and `tui: tuiCommand,` to `main`'s `subCommands`.

- [ ] **Step 4: Manual verification (this task has no automated test — see Task 9)**

Run `bun src/cli/index.ts tui` in a real terminal (not via a test
harness — this needs a real TTY). Confirm: it connects (starts the daemon
if not running), shows a bordered box titled with the workspace name,
and `q` exits cleanly back to the shell prompt with the terminal in a
sane state (not left in raw mode — type a few characters afterward and
confirm they echo normally).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add package.json bun.lock src/cli/commands/tui.ts src/cli/index.ts
git commit -m "feat(tui): cw tui command scaffold — connect, subscribe, quit"
```

---

### Task 4: Session list pane + status bar

**Files:**
- Modify: `src/cli/commands/tui.ts`
- Test: `tests/cli/tui-panes.test.ts` (pure rendering-logic unit tests —
  see Step 1's framing)

**Interfaces:**
- Consumes: `SessionRow` shape from `src/db/repositories/session.ts`
  (`name`, `status`, `enforcementTier`, `tokenSpent`, `costSpentUsd`, ...
  — read the file for the exact full shape), `workspace.info`'s response
  shape (read `src/domain/workspace.ts`'s `WorkspaceManager.info` for the
  exact fields — disk usage in particular).
- Produces: `formatSessionRow(row: SessionRow): { text: string; dot: '●' | '○' | '✕' }`
  and `formatStatusBar(ws: {...}, sessions: SessionRow[], diskInfo: {...}): string`
  — both PURE functions, exported from `tui.ts` (or a small new
  `src/cli/tui-format.ts` if `tui.ts` is getting large — your judgment,
  but keep the pure formatting logic separably testable from the OpenTUI
  wiring either way, since the OpenTUI half itself isn't unit-testable).

**Context:** `bun test` cannot drive a real terminal, so this task's
*testable* surface is the pure data→string formatting logic, not the
actual `Select`/`BoxRenderable` wiring. Structure the code so the
formatting is a plain function OpenTUI's rendering calls, not logic
embedded inside an OpenTUI callback where it can't be unit-tested in
isolation — this split is the actual deliverable of this task, not an
afterthought.

- [ ] **Step 1: Write the failing tests** for the pure formatting functions

```typescript
// tests/cli/tui-panes.test.ts
import { describe, expect, test } from 'bun:test';
import { formatSessionRow, formatStatusBar } from '../../src/cli/commands/tui.js';
// (or '../../src/cli/tui-format.js' if you split it out — adjust the import
// to match wherever you actually put these functions)

describe('formatSessionRow', () => {
  test('running session shows a filled dot and its tier', () => {
    const row = { name: 'alice', status: 'running', enforcementTier: 'T2' } as any;
    const out = formatSessionRow(row);
    expect(out.dot).toBe('●');
    expect(out.text).toContain('alice');
    expect(out.text).toContain('T2');
  });
  test('idle session shows a hollow dot', () => {
    const row = { name: 'bob', status: 'idle', enforcementTier: 'T1' } as any;
    expect(formatSessionRow(row).dot).toBe('○');
  });
  test('ended/dead session shows an x', () => {
    const row = { name: 'carol', status: 'dead', enforcementTier: 'T3' } as any;
    expect(formatSessionRow(row).dot).toBe('✕');
  });
});

describe('formatStatusBar', () => {
  test('aggregates session count and total burn', () => {
    const sessions = [
      { costSpentUsd: 1.0 }, { costSpentUsd: 0.24 },
    ] as any;
    const out = formatStatusBar({ id: 'ws_1', name: 'w' } as any, sessions, { usedBytes: 4_200_000_000, limitBytes: 20_000_000_000 } as any);
    expect(out).toContain('w');
    expect(out).toContain('2 session');
    expect(out).toContain('1.24');
  });
});
```

Read `src/domain/workspace.ts`'s `info()` method NOW for the real disk-
usage field names — the `usedBytes`/`limitBytes` names above are
illustrative, not verified; replace them with whatever that method
actually returns before writing the implementation, and update these
tests to match the real shape.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/tui-panes.test.ts`
Expected: FAIL — functions don't exist.

- [ ] **Step 3: Implement the pure formatting functions**, then wire a
  `Select`-based session list pane and a `TextRenderable` status bar into
  `tui.ts`'s renderer boot from Task 3. Use `@opentui/core`'s `Select`
  construct (per its docs: `.options`, `getSelectedIndex()`,
  `moveUp()`/`moveDown()` — read its actual type signature in
  `node_modules/@opentui/core` for the exact `options` item shape before
  wiring real data into it) for the session list, populated from the
  initial `session.list` fetch (Task 3 already fetches this — thread it
  through) and re-populated whenever a `'tui.invalidate'` notification
  arrives (`client.onNotification`, matching `attach.ts`'s established
  pattern for reading server-pushed notifications).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/tui-panes.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual verification**

`bun src/cli/index.ts tui` against a workspace with 2+ real sessions in
different states — confirm the list shows real names/status dots/tiers,
and the status bar shows real workspace name/session count/disk/burn.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
bun run typecheck
bun test
git add src/cli/commands/tui.ts tests/cli/tui-panes.test.ts
git commit -m "feat(tui): session list + status bar panes"
```

---

### Task 5: Convergence matrix pane

**Files:**
- Modify: `src/cli/commands/tui.ts`
- Test: `tests/cli/tui-panes.test.ts` (extend)

**Interfaces:**
- Consumes: `converge.status`'s response shape — read
  `src/daemon/methods.ts`'s `'converge.status'` handler (around line 490)
  for the EXACT fields it returns (`pairwise: {a, b, result}[]`,
  `fullIntegration`, `degraded`, plus whatever else that handler builds —
  read the full handler body, not just the excerpt used while writing
  this plan).
- Produces: `formatConvergenceMatrix(sessionNames: string[], pairwise: {a,b,result}[]): string[][]`
  — a pure function returning a grid of cell strings (`'clean'` /
  `'conflict'` / `'?'` / `'—'` for the diagonal), exported alongside
  Task 4's formatting functions.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/cli/tui-panes.test.ts
describe('formatConvergenceMatrix', () => {
  test('builds a symmetric grid from pairwise results', () => {
    const grid = formatConvergenceMatrix(
      ['alice', 'bob'],
      [{ a: 'alice', b: 'bob', result: 'clean' }],
    );
    expect(grid[0]![1]).toBe('clean');
    expect(grid[1]![0]).toBe('clean'); // symmetric
    expect(grid[0]![0]).toBe('—'); // diagonal
  });
  test('a pair with no trial yet shows unknown', () => {
    const grid = formatConvergenceMatrix(['alice', 'bob'], []);
    expect(grid[0]![1]).toBe('?');
  });
});
```

Determine the actual branch/name matching this needs — `pairwise` entries
use branch names (`a`/`b` per the plan's own reading of the RPC handler
above), while the session list pane works with session NAMES. Read
`converge.status`'s handler again specifically for how (or whether) it
already resolves branches to session names before returning — if it
doesn't, `formatConvergenceMatrix` needs a `branchToSessionName` lookup
parameter built from the same `session.list` data Task 4 already fetches.
Get this resolution right; a matrix that silently shows branch names
instead of session names (or crashes on a missing lookup) is a real
defect, not a cosmetic gap.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/tui-panes.test.ts -t "formatConvergenceMatrix"`
Expected: FAIL.

- [ ] **Step 3: Implement `formatConvergenceMatrix` and wire the pane**

A `BoxRenderable` containing `TextRenderable` rows (a grid is simplest as
monospaced text rows, not a nested flexbox grid — OpenTUI's flexbox
layout is for panes, not necessarily for a dense N×N text table; render
the grid as pre-formatted text content, matching how `cw converge status`
already prints it). Populate on initial fetch and on `'tui.invalidate'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/tui-panes.test.ts -t "formatConvergenceMatrix"`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Against a workspace with 2+ sessions and at least one completed trial
(may need to wait for a real convergence tick, or seed a trial directly
via the DB in a throwaway test workspace) — confirm the matrix shows
real clean/conflict/unknown cells with session names, not branch names
or placeholders.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
bun run typecheck
bun test
git add src/cli/commands/tui.ts tests/cli/tui-panes.test.ts
git commit -m "feat(tui): convergence matrix pane"
```

---

### Task 6: Radar feed pane

**Files:**
- Modify: `src/cli/commands/tui.ts`
- Test: `tests/cli/tui-panes.test.ts` (extend)

**Interfaces:**
- Consumes: `NotifyEvent`'s discriminated union shape from
  `src/notify/dispatcher.ts` (the same 5-variant type M6b built —
  `collision`, `blocked`, `land` ×2, `convergence`), and that same file's
  `format()` function (exported? check — if not already exported, export
  it; the design doc's §3.2 explicit intent is that the feed's text and
  the desktop notification's text never drift apart, which only holds if
  both literally call the same function).
- Produces: a feed pane that appends one line per `'tui.event'`
  notification received, using `format(event).title`/`.message` (or
  however `format`'s actual return shape is structured — read it before
  wiring this).

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/cli/tui-panes.test.ts
import { format } from '../../src/notify/dispatcher.js';

describe('radar feed line formatting', () => {
  test('a collision tui.event produces the same text format() would give the desktop notification', () => {
    const event = { kind: 'collision', sessionA: 'alice', sessionB: 'bob', path: 'src/x.ts', symbol: 'foo', workspaceId: 'ws_1' } as const;
    const formatted = format(event);
    // Whatever the feed-line function is named — call it here directly, asserting
    // it reuses `formatted`'s fields verbatim rather than re-deriving its own text.
    // Write the actual assertion against the actual function you implement in Step 3
    // (name it, e.g., formatFeedLine(event)), not against `formatted` alone.
  });
});
```

This test's shape depends on decisions made in Step 3 (the exact feed-
line function's name and signature) — write the REAL test once that
function exists, matching this plan's intent (same underlying `format()`
call, not a parallel reimplementation) rather than copying the
illustrative skeleton above verbatim.

- [ ] **Step 2: Run tests to verify the suite still passes up to this point**, then implement.

- [ ] **Step 3: Implement `formatFeedLine(event: NotifyEvent): string`**
  (a thin wrapper around `format()` prefixing a timestamp, e.g.
  `` `${new Date().toLocaleTimeString()}  ${format(event).title}` ``) and
  wire a scrolling feed `BoxRenderable`/`TextRenderable` that appends one
  line per `'tui.event'` received via `client.onNotification`, newest at
  the bottom, capped at some reasonable scrollback (e.g. the last 200
  lines — pick a concrete number, don't leave it unbounded, this process
  can run for a long time).

- [ ] **Step 4: Run the test to verify it passes.**

- [ ] **Step 5: Manual verification**

With `cw tui` running, trigger a real collision from a second terminal
(two sessions editing the same file/symbol) and confirm the feed shows a
new line within the same throttle window the desktop notification itself
would use (M6b's `NotificationGate` — the feed line and the desktop
notification are driven by the SAME `notify()` call, so they should
appear together, not one gated and the other not).

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
bun run typecheck
bun test
git add src/cli/commands/tui.ts src/notify/dispatcher.ts tests/cli/tui-panes.test.ts
git commit -m "feat(tui): live radar feed pane"
```

---

### Task 7: Keymap actions — new session, land, kill/stop, gc

**Files:**
- Modify: `src/cli/commands/tui.ts`
- Test: `tests/cli/tui-actions.test.ts` (new — pure logic only, see below)

**Interfaces:**
- Consumes: `session.new`, `land.session`, `converge.status`'s
  `conflictFree` field (for land-all's order — read
  `src/cli/commands/land.ts`'s existing `ConvergeStatus { conflictFree: string[] }`
  interface, already established in this codebase), `session.kill`,
  `session.stop`, `workspace.gc` RPCs.

**Context:** per spec §4.3's table — `n` new session (inline form: name +
agent), `l` land selected, `L` land all, `k` kill/stop selected (with
confirm), `g` gc (with confirm). Destructive-action confirmation is a
Global Constraint, not optional polish.

- [ ] **Step 1: Write the failing tests** for the one piece of this task
  that's pure logic and independently testable — the land-all ordering
  loop's stop-on-first-failure behavior:

```typescript
// tests/cli/tui-actions.test.ts
import { describe, expect, test } from 'bun:test';
import { landAllInOrder } from '../../src/cli/commands/tui.js'; // adjust path if factored elsewhere

describe('landAllInOrder', () => {
  test('lands each name in order, stopping at the first failure', async () => {
    const attempted: string[] = [];
    const land = async (name: string) => {
      attempted.push(name);
      if (name === 'bob') throw new Error('conflict');
    };
    const results = await landAllInOrder(['alice', 'bob', 'carol'], land);
    expect(attempted).toEqual(['alice', 'bob']); // carol never attempted
    expect(results.landed).toEqual(['alice']);
    expect(results.failedAt).toBe('bob');
  });

  test('all succeed when nothing fails', async () => {
    const attempted: string[] = [];
    const land = async (name: string) => { attempted.push(name); };
    const results = await landAllInOrder(['alice', 'bob'], land);
    expect(attempted).toEqual(['alice', 'bob']);
    expect(results.landed).toEqual(['alice', 'bob']);
    expect(results.failedAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/tui-actions.test.ts`
Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement `landAllInOrder`** (pure, takes an injected
  `land` function so it's testable without a real RPC call — matches this
  codebase's established injectable-dependency pattern):

```typescript
export async function landAllInOrder(
  names: string[],
  land: (name: string) => Promise<void>,
): Promise<{ landed: string[]; failedAt: string | undefined }> {
  const landed: string[] = [];
  for (const name of names) {
    try {
      await land(name);
      landed.push(name);
    } catch {
      return { landed, failedAt: name };
    }
  }
  return { landed, failedAt: undefined };
}
```

Then wire the keymap: `n` opens a minimal 2-field inline form (name text
input, agent text input defaulting to `'claude'` — use `@opentui/core`'s
`InputRenderable`, per its documented `onKeyDown`/focus API) that on
submit calls `client.call('session.new', {...})`; `l` calls
`client.call('land.session', { idOrName: selectedSessionName })`
directly; `L` fetches `converge.status`, reads `.conflictFree`, calls
`landAllInOrder(conflictFree, name => client.call('land.session', {idOrName: name}))`;
`k` shows an inline y/n confirm prompt (a simple `TextRenderable`
"kill <name>? y/n" plus a one-shot keypress listener, not a full modal
component) before calling `client.call('session.kill', {idOrName: selectedSessionName})`;
`g` shows the same confirm pattern before `client.call('workspace.gc', {id: workspaceId})`.

Register these via `@opentui/keymap`'s `keymap.registerLayer` (per its
documented API — read the real type signature in
`node_modules/@opentui/keymap` before wiring, the context7 snippet this
plan cites is illustrative).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/tui-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Each of the 5 actions (new/land/land-all/kill/gc), including confirming
that `k`/`g` genuinely wait for `y` and do nothing on `n` or any other
key, and that a `land.session` failure during `L` stops at the right
session and shows something to the user (not silently swallowed).

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
bun run typecheck
bun test
git add src/cli/commands/tui.ts tests/cli/tui-actions.test.ts
git commit -m "feat(tui): keymap actions — new session, land, kill/stop, gc"
```

---

### Task 8: Attach-in-place

**Files:**
- Modify: `src/cli/commands/tui.ts`
- Test: manual only (spawns a real subprocess + a real PTY — same
  category as `install.sh`, not `bun test`'s domain)

**Interfaces:**
- Consumes: `renderer.suspend()`/`renderer.resume()` from `@opentui/core`
  (confirmed real via that package's docs during brainstorming — verify
  the exact method names against the installed package's types before
  using them, same discipline as every other OpenTUI API surface in this
  plan), `Bun.spawn`.

**Context:** per spec §4.4 — Enter on the selected session suspends the
TUI's own renderer, spawns `cw session attach <name>` as a child process
with inherited stdio, awaits its exit, then resumes. Zero new PTY-relay
code; `src/cli/commands/attach.ts` already handles raw mode, scrollback
replay, and the Ctrl-] detach convention.

- [ ] **Step 1: Determine how to invoke `cw` from inside the running TUI
  process correctly.** This is the plan's flagged open question (spec
  §6) — resolve it now, concretely, rather than deferring further:
  - If running from source (`bun src/cli/index.ts tui`), spawning
    `['bun', process.argv[1] as string, 'session', 'attach', name]`
    (reusing the TUI's own `argv[1]`, the path to `src/cli/index.ts`) is
    guaranteed correct regardless of `PATH`.
  - If running from a compiled `dist/cw` binary,
    `process.execPath` is the path to the `bun` runtime embedded IN the
    compiled binary, not a separate invocable script — spawning
    `[process.execPath, 'session', 'attach', name]` is very likely wrong
    for a `--compile`d binary. The correct approach for a compiled binary
    is almost certainly to re-invoke the CURRENTLY RUNNING executable
    itself: on POSIX, `/proc/self/exe` doesn't exist on macOS, but
    `process.argv[0]` — the path this exact process itself was launched
    as — is the reliable cross-platform (macOS+Linux) answer for a
    `bun build --compile` binary. Verify this concretely: add a temporary
    debug line printing `process.argv` when running `dist/cw tui` (built
    via `bun run scripts/build.ts`) versus `bun src/cli/index.ts tui`,
    compare, and implement branch logic (or a single expression) that
    produces the right invocation in both cases — remove the debug line
    before committing. Do not ship a guess; ship what you actually
    observed.

- [ ] **Step 2: Implement the attach handler**

```typescript
async function attachToSession(name: string, renderer: CliRenderer, selfInvocation: string[]): Promise<void> {
  renderer.suspend();
  try {
    const proc = Bun.spawn([...selfInvocation, 'session', 'attach', name], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    await proc.exited;
  } finally {
    renderer.resume();
  }
}
```

Where `selfInvocation` is whatever Step 1 determined (e.g.
`['bun', process.argv[1] as string]` for source, or
`[process.argv[0] as string]` for a compiled binary — the exact
resolution logic from Step 1). Wire this to the Enter key in the session
list's keymap.

- [ ] **Step 3: Manual verification — both invocation modes**

1. `bun src/cli/index.ts tui`, select a running session, press Enter:
   confirm it attaches (scrollback replays, live output flows), Ctrl-]
   detaches back to the dashboard cleanly (panes still populated, no
   corrupted rendering).
2. `bun run scripts/build.ts` then run the compiled `dist/cw tui` the
   same way — confirm attach/detach works identically from the compiled
   binary. This is the case Step 1 exists to get right; do not skip it.
3. Kill the attached session's process from a THIRD terminal while
   attached via the TUI (simulating a crash) — confirm the TUI's
   `renderer.resume()` still runs (the `finally` in Step 2's code) and
   the dashboard recovers to a usable state, not a hung or corrupted
   terminal.

- [ ] **Step 4: Typecheck, full suite (confirms nothing else regressed), commit**

```bash
bun run typecheck
bun test
git add src/cli/commands/tui.ts
git commit -m "feat(tui): attach-in-place — suspend, spawn cw session attach, resume"
```

---

### Task 9: Manual smoke-test checklist + final verification

**Files:**
- Create: `docs/superpowers/specs/2026-08-15-m8-smoke-test-checklist.md`

- [ ] **Step 1: Write the checklist**, covering every manual-verification
  step from Tasks 3-8 in one place (session list/status bar/matrix/feed
  all show real data; all 5 keyboard actions work including the y/n
  confirms; attach/detach round-trips from both source and compiled-
  binary invocation; a killed attached session's process doesn't leave
  the TUI's terminal in a bad state; `q` always exits cleanly; resizing
  the terminal window while `cw tui` is running doesn't corrupt the
  layout — actually run this last one and note what you observe, per
  spec §6's flagged open question about `renderer.resize`).

- [ ] **Step 2: Run the full checklist for real**, against a real
  workspace with 2+ real sessions, at least once.

- [ ] **Step 3: Full verification**

```bash
bun run typecheck
bun test
```
Expected: 0 typecheck errors, full suite green (kill stray
`dist/cwd`/`src/daemon/main.ts` processes first if
`tests/packaging/binary.test.ts` flakes — this project's well-known
sandbox/back-to-back-runs artifact from M6b/M7).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-15-m8-smoke-test-checklist.md
git commit -m "docs: M8 TUI manual smoke-test checklist"
```
