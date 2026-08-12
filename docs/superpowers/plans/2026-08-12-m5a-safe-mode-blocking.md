# M5a — Safe Mode Blocking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Collision Radar's existing Claude Code `PreToolUse` hook from
advisory-only to real blocking, gated by a per-workspace Safe Mode tier that can now
actually be set and read.

**Architecture:** The blocking decision (`workspace.safeModeTier` vs. the calling
session's `enforcementTier`, vs. whether a collision exists) is computed once, in the
daemon's `radar.check` RPC handler, and returned as a `blocked: boolean` alongside the
existing `collisions` array. `runRadarHook` (the Claude Code hook entry point) just
translates that into the hook protocol's `allow`/`deny` JSON — it holds no policy of
its own. This keeps the policy reusable by a future ACP permission-boundary handler
(M5b), which needs the identical decision over a different transport.

**Tech Stack:** TypeScript, Bun (`bun:sqlite`, `bun test`, `Bun.spawn`), citty (CLI).

## Global Constraints

- Bun >= 1.3.5, TypeScript strict mode — no `any`, `!`, `@ts-ignore` without a stated
  reason (repo-wide convention, see any existing file).
- `bun run typecheck` (== `tsc --noEmit`) and `bun test` must both be clean (0 errors,
  0 failing tests) before any task is considered done.
- Conventional Commits style messages (`feat:`, `fix:`, `test:`, `docs:`); one logical
  change per commit.
- Never commit to `main` — this plan runs entirely on a feature branch (Task 1, Step 1).
- Follow existing repo patterns exactly: repo files under `src/db/repositories/`,
  domain logic under `src/domain/`, RPC handlers in `src/daemon/methods.ts`, CLI
  subcommands under `src/cli/commands/`. Do not introduce new patterns where an
  existing one already fits.
- Every new/changed public error path uses `CrossweaveError(code, message)` with an
  UPPER_SNAKE_CASE code, matching every existing error in the codebase.

---

### Task 1: Correct `ClaudePtyAdapter`'s enforcement tier from T3 to T2

`ClaudePtyAdapter` already injects a real `PreToolUse` hook (see
`radarHookSettings()` in the same file) that can intercept `Edit`/`Write` tool calls —
that is exactly what the roadmap defines T2 to mean
(`docs/superpowers/specs/2026-08-09-crossweave-design.md` §4.10: "Claude Code natively
(hooks + headless SDK + MCP), giving T2"). The `'T3'` label predates M3 wiring the hook
up and was never revisited. This task also creates the feature branch every later task
in this plan builds on.

**Files:**
- Modify: `src/adapters/claude-pty.ts:125-131`
- Modify: `tests/adapters/claude-pty.test.ts:41-45`, `tests/adapters/claude-pty.test.ts:176-180`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ClaudePtyAdapter.enforcementTier` and `createAdapter('claude').enforcementTier`
  are now `'T2'` — every later task in this plan (and the daemon's session rows, via
  `SessionManager.create`) sees `'T2'` for every session from here on.

- [ ] **Step 1: Create the feature branch**

```bash
git checkout main
git checkout -b feat/m5a-safe-mode-blocking
```

- [ ] **Step 2: Update the two failing assertions first (TDD red)**

In `tests/adapters/claude-pty.test.ts`, change:

```ts
  it('reports kind and enforcement tier T3', () => {
    const a = new ClaudePtyAdapter();
    expect(a.kind).toBe('claude');
    expect(a.enforcementTier).toBe('T3');
  });
```

to:

```ts
  it('reports kind and enforcement tier T2', () => {
    const a = new ClaudePtyAdapter();
    expect(a.kind).toBe('claude');
    expect(a.enforcementTier).toBe('T2');
  });
```

and change:

```ts
  it('returns the claude adapter', () => {
    expect(createAdapter('claude').kind).toBe('claude');
    expect(createAdapter('claude').enforcementTier).toBe('T3');
  });
```

to:

```ts
  it('returns the claude adapter', () => {
    expect(createAdapter('claude').kind).toBe('claude');
    expect(createAdapter('claude').enforcementTier).toBe('T2');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/adapters/claude-pty.test.ts`
Expected: 2 FAIL (`expected 'T3' to be 'T2'` or similar), rest pass.

- [ ] **Step 4: Fix the adapter**

In `src/adapters/claude-pty.ts`, replace:

```ts
/**
 * Tier T3: an opaque CLI driven over a pty. crossweave observes output but
 * cannot intercept tool calls, so Safe Mode here is advisory only (spec §2.1).
 */
export class ClaudePtyAdapter implements AgentAdapter {
  readonly kind = 'claude';
  readonly enforcementTier: EnforcementTier = 'T3';
```

with:

```ts
/**
 * Tier T2: drives Claude Code over a pty, but with a real interception point —
 * every invocation gets a `PreToolUse` hook (`radarHookSettings` below) that can
 * allow OR deny a tool call. That is exactly what the roadmap defines T2 to mean
 * (`docs/superpowers/specs/2026-08-09-crossweave-design.md` §4.10: "Claude Code
 * natively (hooks + headless SDK + MCP), giving T2") — this adapter was mislabeled
 * T3 from M0, before M3 wired the hook up; M5a corrects the label to match the
 * capability. T1 (ACP's structured permission boundary) is stronger still: the
 * hook's `matcher: 'Edit|Write'` cannot see a file write made through the `Bash`
 * tool, a blind spot ACP's boundary does not have.
 */
export class ClaudePtyAdapter implements AgentAdapter {
  readonly kind = 'claude';
  readonly enforcementTier: EnforcementTier = 'T2';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/adapters/claude-pty.test.ts`
Expected: all PASS.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/claude-pty.ts tests/adapters/claude-pty.test.ts
git commit -m "fix(adapters): correct ClaudePtyAdapter's enforcement tier from T3 to T2

It already has a real PreToolUse interception point (wired in M3) — the
T3 label predates that and was never revisited. Matches the roadmap's
own definition of T2 (hooks + headless SDK + MCP)."
```

---

### Task 2: `WorkspaceRepo.updateSafeModeTier`

**Files:**
- Modify: `src/db/repositories/workspace.ts`
- Test: `tests/db/workspace-repo.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRow` (already defined in this file, has `safeModeTier: 'T1' | 'T2' | 'T3'`).
- Produces: `WorkspaceRepo.updateSafeModeTier(id: string, tier: WorkspaceRow['safeModeTier']): void`
  — Task 3's `WorkspaceManager.setSafeMode` calls this directly.

- [ ] **Step 1: Write the failing test**

In `tests/db/workspace-repo.test.ts`, add inside the existing `describe('WorkspaceRepo', ...)` block, after the `'deletes a row'` test:

```ts
  it('updateSafeModeTier changes only that column', () => {
    const row = makeRow({ safeModeTier: 'T3' });
    repo.insert(row);
    repo.updateSafeModeTier(row.id, 'T2');
    expect(repo.findById(row.id)).toEqual({ ...row, safeModeTier: 'T2' });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/db/workspace-repo.test.ts`
Expected: FAIL — `repo.updateSafeModeTier is not a function`.

- [ ] **Step 3: Implement it**

In `src/db/repositories/workspace.ts`, add this method to `WorkspaceRepo`, after `delete()`:

```ts
  updateSafeModeTier(id: string, tier: WorkspaceRow['safeModeTier']): void {
    this.db.prepare('UPDATE workspace SET safe_mode_tier = ? WHERE id = ?').run(tier, id);
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/db/workspace-repo.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/workspace.ts tests/db/workspace-repo.test.ts
git commit -m "feat(db): add WorkspaceRepo.updateSafeModeTier"
```

---

### Task 3: `WorkspaceManager.setSafeMode` + default new workspaces to T2

**Files:**
- Modify: `src/domain/workspace.ts`
- Test: `tests/domain/workspace.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRepo.updateSafeModeTier` (Task 2), `WorkspaceManager.resolve` (existing, throws `WORKSPACE_NOT_FOUND`/`WORKSPACE_NAME_AMBIGUOUS`), `CrossweaveError` (existing import).
- Produces: `WorkspaceManager.setSafeMode(idOrName: string, tier: string): WorkspaceRow` —
  throws `SAFE_MODE_TIER_UNAVAILABLE` for `tier === 'T1'`, `INVALID_PARAMS` for anything
  not in `{'T2','T3'}`, otherwise persists and returns the updated row. Task 4's RPC
  handler calls this directly. `WorkspaceManager.init()` now defaults new workspaces to
  `safeModeTier: 'T2'`.

- [ ] **Step 1: Write the failing tests**

In `tests/domain/workspace.test.ts`, change the existing default-tier assertion — find:

```ts
  it('defaults the name to the project directory basename', () => {
    const ws = mgr.init('/tmp/projects/my-app');
    expect(ws.name).toBe('my-app');
    expect(ws.rootPath).toBe('/tmp/projects/my-app');
    expect(ws.defaultIsolation).toBe('worktree');
    expect(ws.safeModeTier).toBe('T3');
  });
```

change the last assertion to:

```ts
    expect(ws.safeModeTier).toBe('T2');
```

Then add a new describe block at the end of the file:

```ts
describe('WorkspaceManager.setSafeMode', () => {
  it('sets T2 and persists it', () => {
    const ws = mgr.init('/tmp/projects/app');
    const updated = mgr.setSafeMode(ws.id, 'T2');
    expect(updated.safeModeTier).toBe('T2');
    expect(mgr.resolve(ws.id).safeModeTier).toBe('T2');
  });

  it('sets T3 and persists it', () => {
    const ws = mgr.init('/tmp/projects/app');
    const updated = mgr.setSafeMode(ws.id, 'T3');
    expect(updated.safeModeTier).toBe('T3');
    expect(mgr.resolve(ws.id).safeModeTier).toBe('T3');
  });

  it('rejects T1 with SAFE_MODE_TIER_UNAVAILABLE — no ACP adapter exists yet', () => {
    const ws = mgr.init('/tmp/projects/app');
    expect(() => mgr.setSafeMode(ws.id, 'T1')).toThrowError(
      expect.objectContaining({ code: 'SAFE_MODE_TIER_UNAVAILABLE' }) as unknown as Error,
    );
    // Unchanged — a rejected set must not partially apply.
    expect(mgr.resolve(ws.id).safeModeTier).toBe('T2');
  });

  it('rejects garbage input with INVALID_PARAMS', () => {
    const ws = mgr.init('/tmp/projects/app');
    expect(() => mgr.setSafeMode(ws.id, 'nope')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PARAMS' }) as unknown as Error,
    );
  });

  it('throws WORKSPACE_NOT_FOUND for an unknown workspace', () => {
    expect(() => mgr.setSafeMode('ghost', 'T2')).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_NOT_FOUND' }) as unknown as Error,
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/domain/workspace.test.ts`
Expected: the default-tier test fails (`T3` !== `T2`); every `setSafeMode` test fails with `mgr.setSafeMode is not a function`.

- [ ] **Step 3: Implement it**

In `src/domain/workspace.ts`, change the `init()` row construction — find:

```ts
      defaultIsolation: 'worktree',
      safeModeTier: 'T3',
    };
```

change to:

```ts
      defaultIsolation: 'worktree',
      safeModeTier: 'T2',
    };
```

Then add this method to `WorkspaceManager`, after `delete()`:

```ts
  private static readonly SETTABLE_SAFE_MODE_TIERS = new Set<WorkspaceRow['safeModeTier']>(['T2', 'T3']);

  /**
   * T1 is rejected outright rather than silently accepted as if it were T2: no
   * ACP-based adapter exists yet (M5a's scope), and accepting it would tell the
   * user they have stronger enforcement than the system can actually provide.
   */
  setSafeMode(idOrName: string, tier: string): WorkspaceRow {
    const workspace = this.resolve(idOrName);
    if (tier === 'T1') {
      throw new CrossweaveError(
        'SAFE_MODE_TIER_UNAVAILABLE',
        'T1 requires an ACP-based adapter, which crossweave does not have yet. Use T2 or T3.',
      );
    }
    if (!WorkspaceManager.SETTABLE_SAFE_MODE_TIERS.has(tier as WorkspaceRow['safeModeTier'])) {
      throw new CrossweaveError('INVALID_PARAMS', `safeModeTier must be T2 or T3, got: ${tier}`);
    }
    this.workspaces.updateSafeModeTier(workspace.id, tier as WorkspaceRow['safeModeTier']);
    return { ...workspace, safeModeTier: tier as WorkspaceRow['safeModeTier'] };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/domain/workspace.test.ts`
Expected: all PASS.

- [ ] **Step 5: Full typecheck and test suite (catches any other place that asserted the old T3 default)**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors. If any OTHER test fails asserting a freshly-`init()`'d workspace's `safeModeTier` is `'T3'`, fix that assertion to `'T2'` the same way — it is exercising the same default this task intentionally changed, not a regression.

- [ ] **Step 6: Commit**

```bash
git add src/domain/workspace.ts tests/domain/workspace.test.ts
git commit -m "feat(domain): WorkspaceManager.setSafeMode; default new workspaces to T2

New workspaces now default to Safe Mode T2 (blocking on) instead of T3
(advisory-only) — safety is the default; T3 remains available via
setSafeMode (wired to the CLI in the next commit) for anyone who wants
today's advisory-only behavior."
```

---

### Task 4: `workspace.setSafeMode` RPC + `cw workspace safe-mode` CLI

**Files:**
- Modify: `src/daemon/methods.ts` (near the other `workspace.*` RPCs, ~line 259-266)
- Modify: `src/cli/commands/workspace.ts`

**Interfaces:**
- Consumes: `workspaces.setSafeMode` (Task 3), `WorkspaceManager` instance already in
  scope in `buildMethods` as `workspaces`, `str()` helper (existing, top of methods.ts),
  `withClient`/`fail` (existing, `../context.js`).
- Produces: RPC method `'workspace.setSafeMode'` taking `{ id: string, tier: string }`,
  returning the updated `WorkspaceRow` (same shape `workspace.info`'s `.workspace`
  already returns). CLI: `cw workspace safe-mode` (no arg, prints current tier) and
  `cw workspace safe-mode <T2|T3>` (sets it).

- [ ] **Step 1: Add the RPC handler**

In `src/daemon/methods.ts`, find:

```ts
    'workspace.gc': async (p) => collectGarbage(db, str(p, 'id')),
```

Add immediately after it:

```ts
    'workspace.setSafeMode': (p) => workspaces.setSafeMode(str(p, 'id'), str(p, 'tier')),
```

- [ ] **Step 2: Run typecheck to confirm the handler compiles against existing types**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Widen the CLI's local `Workspace` type and add the `safe-mode` subcommand**

In `src/cli/commands/workspace.ts`, find:

```ts
interface Workspace { id: string; name: string; rootPath: string }
```

change to:

```ts
interface Workspace { id: string; name: string; rootPath: string; safeModeTier: string }
```

Then, inside `workspaceCommand`'s `subCommands` object, add a new entry after `info:` and before `delete:`:

```ts
    'safe-mode': defineCommand({
      meta: {
        name: 'safe-mode',
        description: "Show or set this workspace's Safe Mode floor (T2 blocks write-write collisions, T3 is advisory-only)",
      },
      args: {
        tier: { type: 'positional', description: 'T2 or T3 — omit to show the current tier', required: false },
      },
      async run({ args }) {
        try {
          await withClient(async (client) => {
            const ws = await client.call<Workspace>('workspace.init', {});
            if (args.tier === undefined) {
              const info = await client.call<{ workspace: Workspace }>('workspace.info', { id: ws.id });
              process.stdout.write(`${info.workspace.safeModeTier}\n`);
              return;
            }
            const updated = await client.call<Workspace>('workspace.setSafeMode', { id: ws.id, tier: args.tier });
            process.stdout.write(`safe mode: ${updated.safeModeTier}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Full test suite (no existing test constructs the `Workspace` CLI interface as a literal, so widening it should not break anything — this step confirms that)**

Run: `bun test`
Expected: all PASS.

- [ ] **Step 6: Manual smoke test against a real daemon**

```bash
TMP=$(mktemp -d "$TMPDIR/cw-smoke-safemode-XXXXXX")
cd "$TMP"
git init -q && git config user.email t@t.com && git config user.name t
echo hi > README.md && git add -A && git commit -qm init

CLI=/Users/nmh/work/Mac/NMHx/Personal/crossweave/src/cli/index.ts
bun "$CLI" workspace safe-mode            # expect: T2 (new default)
bun "$CLI" workspace safe-mode T3         # expect: safe mode: T3
bun "$CLI" workspace safe-mode            # expect: T3
bun "$CLI" workspace safe-mode T1         # expect: SAFE_MODE_TIER_UNAVAILABLE: ... , nonzero exit
bun "$CLI" workspace safe-mode bogus      # expect: INVALID_PARAMS: ..., nonzero exit
bun "$CLI" daemon stop

cd - && rm -rf "$TMP"
```

Expected: matches the comments above exactly; the two error cases print a `CODE: message` line on stderr and exit non-zero (see `fail()` in `src/cli/context.ts`), they do not crash the daemon.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/methods.ts src/cli/commands/workspace.ts
git commit -m "feat(cli): cw workspace safe-mode [T2|T3]"
```

---

### Task 5: `radar.check` RPC computes and returns `blocked`

**Files:**
- Modify: `src/daemon/methods.ts` (the `'radar.check'` handler, ~line 340-359)
- Test: `tests/daemon/methods-radar.test.ts`

**Interfaces:**
- Consumes: `workspaces.resolve(workspaceId).safeModeTier` (existing `WorkspaceManager.resolve`), `sessions.resolve(workspaceId, sessionId).enforcementTier` (existing `SessionManager.resolve`, same pattern the handler already uses for `c.sessionId` below).
- Produces: `radar.check` RPC now returns `{ collisions: (Collision & { sessionName: string })[], blocked: boolean }` — Task 6's `RadarCheckFn` type is built to match this exactly.

- [ ] **Step 1: Write the failing tests**

In `tests/daemon/methods-radar.test.ts`, first add `expect(result.blocked).toBe(false)` to the existing test (the seeded session `s_1` has `enforcementTier: 'T3'`, so it can never block regardless of workspace tier — document why):

```ts
    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { collisions: unknown[]; blocked: boolean };

    expect(result.collisions).toHaveLength(1);
    // s_1's own enforcementTier is T3 (an opaque adapter that cannot intercept
    // anything), so it can never be blocked no matter the workspace's Safe Mode.
    expect(result.blocked).toBe(false);
```

Then add a new describe block at the end of the file:

```ts
describe('radar.check RPC: blocked', () => {
  function seed(safeModeTier: 'T1' | 'T2' | 'T3', querierTier: 'T2' | 'T3', withCollision: boolean) {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier,
    });
    const sessions = new SessionRepo(db);
    sessions.insert({
      id: 's_1', workspaceId: 'ws_1', name: 's_1', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: '/tmp/w/s_1', branch: 'cw/s_1', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: querierTier, pid: null,
    });
    if (withCollision) {
      sessions.insert({
        id: 's_2', workspaceId: 'ws_1', name: 's_2', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: '/tmp/w/s_2', branch: 'cw/s_2', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T2', pid: null,
      });
      new FileClaimRepo(db).upsert({
        id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
        kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
      });
    }
    return db;
  }

  async function check(db: ReturnType<typeof openDatabase>): Promise<{ collisions: unknown[]; blocked: boolean }> {
    const methods = buildMethods(db, '/tmp/w');
    return methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' },
      { notify: () => undefined, onClose: () => undefined },
    ) as Promise<{ collisions: unknown[]; blocked: boolean }>;
  }

  test('T2 workspace + T2 querying session + collision: blocked', async () => {
    expect((await check(seed('T2', 'T2', true))).blocked).toBe(true);
  });

  test('T3 workspace (advisory-only) + T2 querying session + collision: not blocked', async () => {
    expect((await check(seed('T3', 'T2', true))).blocked).toBe(false);
  });

  test('T2 workspace + T3 querying session (cannot intercept anything) + collision: not blocked', async () => {
    expect((await check(seed('T2', 'T3', true))).blocked).toBe(false);
  });

  test('T2 workspace + T2 querying session + no collision: not blocked', async () => {
    const result = await check(seed('T2', 'T2', false));
    expect(result.blocked).toBe(false);
    expect(result.collisions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/daemon/methods-radar.test.ts`
Expected: FAIL — `result.blocked` is `undefined`, not `false`/`true` (the RPC does not return that field yet).

- [ ] **Step 3: Implement it**

In `src/daemon/methods.ts`, replace the `'radar.check'` handler:

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

with:

```ts
    'radar.check': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const sessionId = str(p, 'sessionId');
      const symbol = optionalStr(p, 'symbol');
      const collisions = checkCollisions(fileClaims, {
        workspaceId,
        sessionId,
        path: str(p, 'path'),
        symbol,
      });
      // checkCollisions stays pure (FileClaimRepo only, no session lookups —
      // see Task 6's unit tests). Session NAMES are a display concern, added
      // here where `sessions` is already in scope, for the one consumer that
      // needs a human-readable name: Task 9's hook advisory text.
      //
      // `blocked` is computed HERE, not in the hook, so the policy (workspace
      // floor x this session's own capability x whether a collision even
      // exists) is defined exactly once — a future ACP permission-boundary
      // handler (M5b) needs the identical decision over a different transport.
      const safeModeTier = workspaces.resolve(workspaceId).safeModeTier;
      const enforcementTier = sessions.resolve(workspaceId, sessionId).enforcementTier;
      const blocked = safeModeTier !== 'T3' && enforcementTier !== 'T3' && collisions.length > 0;
      return {
        blocked,
        collisions: collisions.map((c) => ({
          ...c,
          sessionName: sessions.resolve(workspaceId, c.sessionId).name,
        })),
      };
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/daemon/methods-radar.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/methods.ts tests/daemon/methods-radar.test.ts
git commit -m "feat(daemon): radar.check computes and returns \`blocked\`

blocked = workspace.safeModeTier !== T3 && session.enforcementTier !== T3
       && collisions.length > 0

Computed server-side (not in the hook) so the policy is defined once —
a future ACP permission-boundary handler needs the identical decision
over a different transport."
```

---

### Task 6: `runRadarHook` gains a real deny path

**Files:**
- Modify: `src/cli/commands/radar-hook.ts`
- Test: `tests/cli/radar-hook.test.ts`

**Interfaces:**
- Consumes: `radar.check`'s new `{ collisions, blocked }` shape (Task 5).
- Produces: `RadarCheckFn` type now returns `Promise<{ collisions: Collision[]; blocked: boolean }>`
  — this is a breaking type change for every `RadarCheckFn`-typed value in the test
  file (fixed in this task's Step 1). `runRadarHook` returns a real
  `hookSpecificOutput.permissionDecision: 'deny'` JSON string when `blocked` is true.

- [ ] **Step 1: Write the failing tests (and fix the type break in existing fixtures first)**

In `tests/cli/radar-hook.test.ts`, update the two module-level fixtures — find:

```ts
const NO_COLLISION: RadarCheckFn = async () => ({ collisions: [] });
const ONE_COLLISION: RadarCheckFn = async () => ({
  collisions: [{ sessionId: 's_2', sessionName: 'other', path: 'src/x.ts', symbol: 'foo', kind: 'function' }],
});
```

replace with:

```ts
const NO_COLLISION: RadarCheckFn = async () => ({ collisions: [], blocked: false });
const ONE_COLLISION: RadarCheckFn = async () => ({
  collisions: [{ sessionId: 's_2', sessionName: 'other', path: 'src/x.ts', symbol: 'foo', kind: 'function' }],
  blocked: false,
});
const BLOCKED_COLLISION: RadarCheckFn = async () => ({
  collisions: [{ sessionId: 's_2', sessionName: 'other', path: 'src/x.ts', symbol: 'foo', kind: 'function' }],
  blocked: true,
});
```

Then find the three remaining inline `RadarCheckFn`-typed values that each return
`{ collisions: [] }` without `blocked` (a spy inside `'a non-Edit/Write tool call...'`,
a spy inside `'a file_path escaping cwd...'`, and `capture` inside the symlink describe
block) and add `, blocked: false` to each of their return objects — e.g.:

```ts
    const spy: RadarCheckFn = async () => { called = true; return { collisions: [], blocked: false }; };
```

```ts
    const capture: RadarCheckFn = async (_cwd, path) => {
      capturedPath = path;
      return { collisions: [], blocked: false };
    };
```

Then add two new tests inside `describe('runRadarHook', ...)`, after the existing
`'a collision: still allow, but additionalContext names the other session'` test:

```ts
  test('a blocked collision: deny, with a reason naming the other session', async () => {
    const out = await runRadarHook(stdinFor('Write', join(cwd, 'src', 'x.ts')), BLOCKED_COLLISION);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('other');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('foo');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('src/x.ts');
  });

  test('a block is never throttled by the noise-control gate, unlike an advisory allow', async () => {
    // The gate caps ADVISORY notifications at 6 per 10 minutes (src/radar/noise.ts).
    // Firing the SAME collision through the hook 7 times in a row proves a block
    // never goes through that gate at all — it must deny every single time.
    for (let i = 0; i < 7; i += 1) {
      const out = await runRadarHook(stdinFor('Write', join(cwd, 'src', 'x.ts')), BLOCKED_COLLISION);
      expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/cli/radar-hook.test.ts`
Expected: type error at compile time first if any fixture is missed (`bun test` will
report it as a failure to load the file); once fixtures are fixed, the two new tests
fail — `permissionDecision` is `'allow'`, not `'deny'` (no deny path exists yet).

- [ ] **Step 3: Implement it**

In `src/cli/commands/radar-hook.ts`, change the `RadarCheckFn` type — find:

```ts
export type RadarCheckFn = (
  cwd: string, path: string, symbol: string | undefined,
) => Promise<{ collisions: Collision[] }>;
```

replace with:

```ts
export type RadarCheckFn = (
  cwd: string, path: string, symbol: string | undefined,
) => Promise<{ collisions: Collision[]; blocked: boolean }>;
```

Add a `deny()` builder and a shared message builder right after `allow()`:

```ts
function deny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function collisionMessage(collisions: Collision[], repoRelative: string, blocked: boolean): string {
  const names = [...new Set(collisions.map((c) => c.sessionName))].join(', ');
  const symbols = [...new Set(collisions.map((c) => c.symbol ?? '(whole file)'))].join(', ');
  const base = `crossweave Radar: session(s) ${names} also have divergent changes to ${repoRelative} (${symbols}).`;
  return blocked ? `${base} Blocked — this workspace's Safe Mode does not allow write-write collisions.` : base;
}
```

Replace the body of the main `try` block in `runRadarHook` — find:

```ts
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
```

replace with:

```ts
  try {
    const { collisions, blocked } = await check(cwd, repoRelative, undefined);
    if (collisions.length === 0) return allow();

    // A real block bypasses the noise-control gate entirely: the gate exists to
    // cap ADVISORY token spend (§4.8), and must never suppress a safety-relevant
    // deny — an agent retrying the same blocked edit must be denied every time.
    if (blocked) return deny(collisionMessage(collisions, repoRelative, true));

    const notifiable = collisions.filter((c) => gate.shouldNotify(cwd, c.path, c.symbol));
    if (notifiable.length === 0) return allow();

    return allow(collisionMessage(notifiable, repoRelative, false));
  } catch {
    return allow(); // daemon unreachable, RPC failed, etc. — degrade silently, never block
  }
```

Finally, update the real RPC-calling closure at the bottom of the file (inside
`radarHookCommand`'s `run()`) — find:

```ts
        return await client.call<{ collisions: Collision[] }>('radar.check', {
          workspaceId, sessionId, path, symbol,
        });
```

replace with:

```ts
        return await client.call<{ collisions: Collision[]; blocked: boolean }>('radar.check', {
          workspaceId, sessionId, path, symbol,
        });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/cli/radar-hook.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/radar-hook.ts tests/cli/radar-hook.test.ts
git commit -m "feat(radar): runRadarHook denies on a real block, bypassing the noise gate

When radar.check returns blocked:true, the hook returns
hookSpecificOutput.permissionDecision: 'deny' with a
permissionDecisionReason naming the colliding session/file/symbol —
schema confirmed against code.claude.com/docs/en/hooks.md. The
NotificationGate rate limit (6/10min) only ever applied to the
advisory allow path and is never consulted on the deny path, so a
genuine block is never silently throttled away."
```

---

### Task 7: Full verification, adapter comment sanity check, wrap-up

**Files:** none new — this task only runs checks and writes the M5a completion note.

**Interfaces:** none.

- [ ] **Step 1: Full local gate**

```bash
bun run typecheck
bun test
```

Expected: `tsc --noEmit` reports 0 errors; `bun test` reports 0 fail (should be
424 (M4 baseline) + trust-gate tests from the prior feature, if that branch's work is
merged, or the M4 baseline + this plan's new tests if branched from `main` directly —
in either case, 0 fail, and note the exact pass count in the final report).

- [ ] **Step 2: Confirm no other test asserts the old `T3`-by-default or `T3`-tier-adapter behavior**

```bash
grep -rn "enforcementTier.*T3\|safeModeTier.*T3" tests/ | grep -v "\.only\b"
```

Read through the results: every remaining `'T3'` in test fixtures should be an
EXPLICIT, deliberate choice (e.g. a test constructing a session/workspace to prove the
T3 no-blocking case), never a leftover assumption about defaults. Fix any that are
leftover assumptions.

- [ ] **Step 3: Final report**

No commit in this step — Task 1 through 6 already committed everything. Report to the
user: files changed, test count, confirmation that `bun run typecheck` and `bun test`
are both clean, and that the branch `feat/m5a-safe-mode-blocking` is ready for review
(not merged — merging to `main` requires the user's explicit go-ahead per this
project's standing rule).

---

## Deferred (explicitly out of scope, per the approved spec §6)

- ACP client, Cursor adapter — blocked on the roadmap's own open research question
  (verify native ACP support before designing against it).
- `--trusted` flag — `cw workspace safe-mode T3` already gives a workspace-level
  off-switch.
- Any change to how dead/landed sessions' claims participate in collision detection.
