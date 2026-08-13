# M5b — ACP Client (Cursor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a T1-enforcement adapter for Cursor, speaking ACP (Agent Client Protocol)
natively over stdio, reusing crossweave's existing Safe Mode blocking policy from M5a but
now enforced synchronously over every tool call Cursor makes — not just `Edit`/`Write`.

**Architecture:** `AcpAdapter` implements the existing `AgentAdapter` interface (built for
PTY passthrough) by translating ACP's structured JSON-RPC into that shape: `write()`
becomes `session/prompt`, `session/update` notifications become text handed to `onData`,
and — the actual point of this milestone — ACP's `session/request_permission` becomes a
synchronous call into a blocking-decision function extracted from M5a's `radar.check` RPC
handler, so the exact same policy now runs in-process instead of over a separate hook
subprocess.

**Tech Stack:** TypeScript, Bun, `@agentclientprotocol/sdk` (new dependency), `node:child_process`.

## Global Constraints

- Bun >= 1.3.5, TypeScript strict mode — no `any`, `!`, `@ts-ignore` without a stated reason.
- `bun run typecheck` (tsc --noEmit) and `bun test` must both be clean before any task is done.
- Conventional Commits style messages (`feat:`, `fix:`, `test:`, `docs:`); one logical
  change per commit.
- Never commit to `main` — this plan runs entirely on a feature branch.
- Follow existing repo patterns exactly: repo files under `src/db/repositories/`, domain
  logic under `src/domain/`, adapters under `src/adapters/`, RPC handlers in
  `src/daemon/methods.ts`, test fixtures under `tests/helpers/`.
- `AcpAdapter.enforcementTier` MUST be `'T1'`. `AcpAdapter.kind` MUST be `'cursor'`.
- `decideBlocked`'s formula MUST stay exactly: `safeModeTier !== 'T3' && enforcementTier
  !== 'T3' && collisions.length > 0` — this is the policy M5a shipped; this plan only
  relocates it, never changes it.
- ACP schema/API facts used throughout this plan (method names, type shapes) were verified
  2026-08-13 against `@agentclientprotocol/sdk@1.3.0`'s own shipped `.d.ts` files and the
  package's official examples (`agentclientprotocol/typescript-sdk`,
  `src/examples/client.ts` / `src/examples/agent.ts`) — not memory, not guesses. Package
  name is `@agentclientprotocol/sdk`, NOT the deprecated `@zed-industries/agent-client-protocol`.

---

### Task 1: Extract `decideBlocked` from `radar.check`

Pure refactor, zero behavior change — moves the blocking-policy logic M5a built inline in
the `radar.check` RPC handler into a standalone function both the hook path (unchanged)
and M5b's ACP permission handler (Task 4) can call. This task touches no ACP code at all.

**Files:**
- Create: `src/radar/decision.ts`
- Create: `tests/radar/decision.test.ts`
- Modify: `src/daemon/methods.ts:21` (import), `src/daemon/methods.ts:341-370` (the `'radar.check'` handler)
- Modify: `tests/daemon/methods-radar.test.ts` (remove the now-duplicated `describe('radar.check RPC: blocked', ...)` block — its cases moved verbatim into `tests/radar/decision.test.ts`)

**Interfaces:**
- Consumes: `checkCollisions` (existing, `src/radar/collisions.js`), `WorkspaceManager`
  (existing, `src/domain/workspace.js`, has `.resolve(id): WorkspaceRow`), `SessionManager`
  (existing, `src/domain/session.js`, has `.resolve(workspaceId, idOrName): SessionRow`),
  `FileClaimRepo` (existing, `src/db/repositories/file-claim.js`).
- Produces: `decideBlocked(deps: DecideBlockedDeps, params: DecideBlockedParams):
  DecideBlockedResult` — `DecideBlockedDeps = { fileClaims: FileClaimRepo; workspaces:
  WorkspaceManager; sessions: SessionManager }`, `DecideBlockedParams = { workspaceId:
  string; sessionId: string; path: string; symbol?: string }`, `DecideBlockedResult = {
  collisions: Collision[]; blocked: boolean }`. Task 4's `AcpAdapter` calls this directly.

- [ ] **Step 1: Write the failing test — move the blocked-matrix tests to call `decideBlocked` directly**

Create `tests/radar/decision.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { decideBlocked } from '../../src/radar/decision.js';

describe('decideBlocked', () => {
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

  function check(db: ReturnType<typeof openDatabase>) {
    const deps = {
      fileClaims: new FileClaimRepo(db),
      workspaces: new WorkspaceManager(db),
      sessions: new SessionManager(db),
    };
    return decideBlocked(deps, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' });
  }

  test('T2 workspace + T2 querying session + collision: blocked', () => {
    expect(check(seed('T2', 'T2', true)).blocked).toBe(true);
  });

  test('T3 workspace (advisory-only) + T2 querying session + collision: not blocked', () => {
    expect(check(seed('T3', 'T2', true)).blocked).toBe(false);
  });

  test('T2 workspace + T3 querying session (cannot intercept anything) + collision: not blocked', () => {
    expect(check(seed('T2', 'T3', true)).blocked).toBe(false);
  });

  test('T2 workspace + T2 querying session + no collision: not blocked', () => {
    const result = check(seed('T2', 'T2', false));
    expect(result.blocked).toBe(false);
    expect(result.collisions).toHaveLength(0);
  });

  test('T1 workspace + T2 querying session + collision: blocked (T1 is not settable via setSafeMode until Task 5, but the formula itself already treats it as blocking-capable, not advisory)', () => {
    expect(check(seed('T1', 'T2', true)).blocked).toBe(true);
  });
});
```

Then edit `tests/daemon/methods-radar.test.ts` to remove the block these five tests were
moved from — replace the whole file with:

```ts
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
    )) as { collisions: unknown[]; blocked: boolean };

    expect(result.collisions).toHaveLength(1);
    // s_1's own enforcementTier is T3 (an opaque adapter that cannot intercept
    // anything), so it can never be blocked no matter the workspace's Safe Mode.
    expect(result.blocked).toBe(false);
  });
});
```

(This is exactly the file's original first `describe` block — the `'radar.check RPC:
blocked'` block that followed it in the file is deleted entirely; its 5 cases now live in
`tests/radar/decision.test.ts` above.)

- [ ] **Step 2: Run both files to verify the expected failures**

Run: `bun test tests/radar/decision.test.ts`
Expected: FAIL — `Cannot find module '../../src/radar/decision.js'` (doesn't exist yet).

Run: `bun test tests/daemon/methods-radar.test.ts`
Expected: PASS (this file is unchanged in behavior, only trimmed — it should already pass
against the current, un-refactored `radar.check` handler).

- [ ] **Step 3: Create `src/radar/decision.ts`**

```ts
import type { FileClaimRepo } from '../db/repositories/file-claim.js';
import type { WorkspaceManager } from '../domain/workspace.js';
import type { SessionManager } from '../domain/session.js';
import { checkCollisions, type Collision } from './collisions.js';

export interface DecideBlockedDeps {
  fileClaims: FileClaimRepo;
  workspaces: WorkspaceManager;
  sessions: SessionManager;
}

export interface DecideBlockedParams {
  workspaceId: string;
  sessionId: string;
  path: string;
  symbol?: string;
}

export interface DecideBlockedResult {
  collisions: Collision[];
  blocked: boolean;
}

/**
 * The blocking policy — workspace floor x this session's own capability x whether a
 * collision even exists — lives here, exactly once, so every caller gets the identical
 * decision: the Claude Code PreToolUse hook via `radar.check` (src/daemon/methods.ts),
 * and M5b's in-process ACP permission handler (src/adapters/acp.ts). Extracted verbatim
 * from radar.check's M5a implementation — no behavior change.
 */
export function decideBlocked(deps: DecideBlockedDeps, params: DecideBlockedParams): DecideBlockedResult {
  const collisions = checkCollisions(deps.fileClaims, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    path: params.path,
    symbol: params.symbol,
  });
  const safeModeTier = deps.workspaces.resolve(params.workspaceId).safeModeTier;
  const enforcementTier = deps.sessions.resolve(params.workspaceId, params.sessionId).enforcementTier;
  const blocked = safeModeTier !== 'T3' && enforcementTier !== 'T3' && collisions.length > 0;
  return { collisions, blocked };
}
```

- [ ] **Step 4: Update `src/daemon/methods.ts` to call it**

Find (the import block near the top):

```ts
import { checkCollisions } from '../radar/collisions.js';
```

Replace with:

```ts
import { decideBlocked } from '../radar/decision.js';
```

(`checkCollisions` is no longer called directly from this file — `decideBlocked` calls it
internally. Confirm with `grep -n "checkCollisions" src/daemon/methods.ts` that this was
the only reference before deleting the import; if you find another, keep the import and
just add the new one alongside it instead.)

Find the `'radar.check'` handler:

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

Replace with:

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

- [ ] **Step 5: Run both test files, and the full suite, to verify green**

Run: `bun test tests/radar/decision.test.ts tests/daemon/methods-radar.test.ts`
Expected: all PASS.

Run: `bun test`
Expected: all PASS (this is a pure extraction — nothing else should change).

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/radar/decision.ts src/daemon/methods.ts tests/radar/decision.test.ts tests/daemon/methods-radar.test.ts
git commit -m "refactor(radar): extract decideBlocked from the radar.check RPC handler

Pure extraction, no behavior change — M5b's ACP permission handler
needs the identical blocking policy, called in-process rather than
over radar.check's RPC. Test coverage for the blocked-tier matrix
moves with the function, from tests/daemon/methods-radar.test.ts to
tests/radar/decision.test.ts."
```

---

### Task 2: Add the ACP SDK dependency and a fake ACP agent test fixture

Adds `@agentclientprotocol/sdk` and builds a minimal, spec-correct fake agent process that
later tasks' tests spawn instead of the real `cursor-agent` binary (unavailable in CI — it
requires a live Cursor account). Mirrors `ClaudePtyAdapter`'s existing tests, which spawn
`sh -c '...'` fake commands instead of a real `claude` install.

**Files:**
- Modify: `package.json` (add dependency)
- Create: `tests/helpers/fake-acp-agent.ts`

**Interfaces:**
- Consumes: `@agentclientprotocol/sdk`'s `agent()` builder, `ndJsonStream`, `PROTOCOL_VERSION`.
- Produces: a runnable script at `tests/helpers/fake-acp-agent.ts` that Task 3/4's tests
  spawn via `[process.execPath, '<path-to-this-file>']`. Protocol it implements, driven
  entirely by the text of each `session/prompt` it receives:
  - `"__PING__"` → sends one `agent_message_chunk` `"PONG"`, then `stopReason: 'end_turn'`.
  - `"__TOOL_CALL__"` → sends a `tool_call` update (`kind: 'edit'`, `title: 'test tool'`,
    `toolCallId: 'call_1'`), then a `tool_call_update` (`status: 'completed'`), then one
    `agent_message_chunk` `"DONE"`, then `stopReason: 'end_turn'`.
  - `"__REQUEST_PERMISSION__:<json>"` → parses the JSON as `{ locations?: {path:
    string}[]; kind?: string }`, fires `session/request_permission` with that `toolCall`
    shape and two options (`allow_once`/`optionId: 'allow'`, `reject_once`/`optionId:
    'reject'`), then sends one `agent_message_chunk`
    `"PERMISSION_RESULT:<chosen optionId, or 'cancelled'>"`, then `stopReason: 'end_turn'`.
  - anything else → echoed back verbatim as one `agent_message_chunk`.

- [ ] **Step 1: Add the dependency**

In `package.json`, find:

```json
  "dependencies": {
    "citty": "^0.2.2",
    "simple-git": "^3.36.0",
    "web-tree-sitter": "0.26.12"
  },
```

Replace with:

```json
  "dependencies": {
    "@agentclientprotocol/sdk": "^1.3.0",
    "citty": "^0.2.2",
    "simple-git": "^3.36.0",
    "web-tree-sitter": "0.26.12"
  },
```

Run: `bun install`
Expected: installs `@agentclientprotocol/sdk` (pure TS/JS — no native module; if `bun
install` reports a native build step for it or any of its transitive dependencies, STOP
and report NEEDS_CONTEXT rather than proceeding — this project's design principle is zero
native dependencies, see `docs/superpowers/specs/2026-08-09-crossweave-design.md` §7).

- [ ] **Step 2: Write the fake agent script**

Create `tests/helpers/fake-acp-agent.ts`:

```ts
#!/usr/bin/env bun
// A minimal ACP agent for tests — NOT a real coding agent. Speaks just enough of the
// protocol, using the same @agentclientprotocol/sdk production code depends on, for
// AcpAdapter's tests to exercise real, spec-correct ACP framing without depending on a
// real `cursor-agent` binary (needs a live account, unavailable in CI). Mirrors how
// ClaudePtyAdapter's existing tests use `sh -c '...'` fake commands instead of a real
// `claude` install.
//
// Protocol, driven entirely by the text of each session/prompt it receives — see the
// Task 2 brief in docs/superpowers/plans/2026-08-13-m5b-acp-client.md for the full
// contract this implements.
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const sessions = new Set<string>();

async function initialize(): Promise<acp.InitializeResponse> {
  return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
}

async function newSession(): Promise<acp.NewSessionResponse> {
  const sessionId = crypto.randomUUID();
  sessions.add(sessionId);
  return { sessionId };
}

async function sendText(cx: acp.AgentContext, sessionId: string, text: string): Promise<void> {
  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

async function prompt(params: acp.PromptRequest, cx: acp.AgentContext): Promise<acp.PromptResponse> {
  const block = params.prompt[0];
  const text = block !== undefined && block.type === 'text' ? block.text : '';
  const sessionId = params.sessionId;

  if (text === '__PING__') {
    await sendText(cx, sessionId, 'PONG');
    return { stopReason: 'end_turn' };
  }

  if (text === '__TOOL_CALL__') {
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'test tool',
        kind: 'edit', status: 'pending', locations: [],
      },
    });
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' },
    });
    await sendText(cx, sessionId, 'DONE');
    return { stopReason: 'end_turn' };
  }

  const marker = '__REQUEST_PERMISSION__:';
  if (text.startsWith(marker)) {
    const parsed = JSON.parse(text.slice(marker.length)) as {
      locations?: { path: string }[];
      kind?: acp.ToolKind;
    };
    const response = await cx.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId: 'call_1', title: 'test tool call', kind: parsed.kind ?? 'edit',
        status: 'pending', locations: parsed.locations ?? [],
      },
      options: [
        { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
    });
    const result = response.outcome.outcome === 'cancelled' ? 'cancelled' : response.outcome.optionId;
    await sendText(cx, sessionId, `PERMISSION_RESULT:${result}`);
    return { stopReason: 'end_turn' };
  }

  await sendText(cx, sessionId, text);
  return { stopReason: 'end_turn' };
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;

acp
  .agent({ name: 'fake-acp-agent' })
  .onRequest('initialize', () => initialize())
  .onRequest('session/new', () => newSession())
  .onRequest('session/prompt', (ctx) => prompt(ctx.params, ctx.client))
  .connect(acp.ndJsonStream(input, output));
```

- [ ] **Step 3: Verify it runs standalone (smoke check, not yet exercised by a real test)**

Run: `echo '' | bun tests/helpers/fake-acp-agent.ts &`, then check it didn't immediately
crash: `sleep 0.5; jobs`. Kill it: `kill %1`.

Expected: the process stays alive (waiting on stdio for JSON-RPC input) rather than
exiting immediately with an error. This is a smoke check only — Task 3 writes the first
real test that talks to it over the actual protocol.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors (this file is under `tests/**/*.ts`, included in `tsconfig.json`).

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock tests/helpers/fake-acp-agent.ts
git commit -m "test: add @agentclientprotocol/sdk dependency and a fake ACP agent fixture

The fake agent speaks real, spec-correct ACP framing (via the same
SDK production code will use) so AcpAdapter's tests exercise the
actual wire protocol without depending on a real cursor-agent binary,
which needs a live account and isn't available in CI."
```

(If `bun install` produced a different lockfile name or none at all, adjust the `git add`
line to match whatever `bun install` actually wrote — check with `git status --short`
before committing.)

---

> **Addendum, added after Task 2's implementation (not in the original brief text Task 2
> worked from, but incorporated into Task 3's code below):** Task 2 found that this repo's
> pinned `typescript@^7.0.2` rejects a direct `as ReadableStream<Uint8Array>` cast on
> `Readable.toWeb()`'s return value — `node:stream`'s Web-Streams type is structurally
> distinct from the global DOM-lib `ReadableStream` this project's tsconfig resolves, and
> TS refuses the cast as "neither type sufficiently overlaps." The fix, already applied in
> Task 3's code below, is `as unknown as ReadableStream<Uint8Array>` — zero runtime effect,
> standard idiom for this exact situation. If Task 4 or later needs another `Readable.toWeb`/
> `Writable.toWeb` conversion, use the same double-cast.

### Task 3: `AcpAdapter` — protocol translation (spawn, write, onData, kill)

Builds the adapter shell: spawning the ACP subprocess, the `initialize`/`session/new`
handshake, translating `write()`→`session/prompt` and `session/update`→`onData` text
(including tool-call rendering). Permission handling is stubbed (always picks the first
`allow_once` option, or the first option if none is offered) — Task 4 replaces the stub
with the real decision.

**Files:**
- Create: `src/adapters/acp.ts`
- Test: `tests/adapters/acp.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`/`AgentProcess`/`SpawnOptions` (existing, `src/adapters/types.js`),
  `@agentclientprotocol/sdk`'s `ClientSideConnection`, `ndJsonStream`, `PROTOCOL_VERSION`,
  `Client`/`RequestPermissionRequest`/`RequestPermissionResponse`/`SessionNotification`/`SessionUpdate` types.
- Produces: `export class AcpAdapter implements AgentAdapter` — `kind: 'cursor'`,
  `enforcementTier: 'T1'`, `constructor(deps: AcpAdapterDeps, command = 'cursor-agent',
  args: string[] = ['agent', 'acp'])`. `AcpAdapterDeps` is defined here (Task 4 adds
  fields to it — see Task 4's brief for the final shape); this task's version is:
  `export interface AcpAdapterDeps {}` (deliberately empty — Task 4 fills it in; keeping
  the type in this file from the start means Task 4's diff is additive, not a rename).

- [ ] **Step 1: Write the failing test — basic text round-trip and tool-call rendering**

Create `tests/adapters/acp.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { AcpAdapter } from '../../src/adapters/acp.js';

const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-acp-agent.ts', import.meta.url));

function collect(proc: { onData(cb: (c: string) => void): void }): () => string {
  let buf = '';
  proc.onData((c) => { buf += c; });
  return () => buf;
}

/** Polls until `predicate()` is true or the timeout elapses — ACP round-trips are async
 * (spawn -> initialize -> session/new -> prompt -> update), unlike ClaudePtyAdapter's
 * synchronous pty write, so tests can't just await one call and read the result. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('AcpAdapter', () => {
  it('reports kind and enforcement tier T1', () => {
    const adapter = new AcpAdapter({}, process.execPath, [FAKE_AGENT]);
    expect(adapter.kind).toBe('cursor');
    expect(adapter.enforcementTier).toBe('T1');
  });

  it('spawn -> write("__PING__") round-trips to "PONG" via onData', async () => {
    const adapter = new AcpAdapter({}, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('__PING__');
    await waitFor(() => read().includes('PONG'));
    proc.kill();
  });

  it('a tool_call/tool_call_update pair renders as a readable bracketed line via onData', async () => {
    const adapter = new AcpAdapter({}, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('__TOOL_CALL__');
    await waitFor(() => read().includes('DONE'));
    expect(read()).toContain('[cursor: edit test tool]');
    proc.kill();
  });

  it('resize is a no-op (no throw) — ACP has no terminal concept', async () => {
    const adapter = new AcpAdapter({}, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    expect(() => proc.resize(100, 40)).not.toThrow();
    proc.kill();
  });

  it('kill terminates the child process', async () => {
    const adapter = new AcpAdapter({}, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const exited = new Promise<number>((res) => proc.onExit(res));
    proc.kill();
    await expect(exited).resolves.toBeTypeOf('number');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/adapters/acp.test.ts`
Expected: FAIL — `Cannot find module '../../src/adapters/acp.js'` (doesn't exist yet).

- [ ] **Step 3: Implement `src/adapters/acp.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection, ndJsonStream, PROTOCOL_VERSION,
  type Agent, type Client, type RequestPermissionRequest, type RequestPermissionResponse,
  type SessionNotification, type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { EnforcementTier } from '../db/repositories/session.js';
import type { AgentAdapter, AgentProcess, SpawnOptions } from './types.js';

/**
 * Filled in by Task 4 with `resolveWorkspaceId`/`decideBlocked` — deliberately empty
 * here so Task 3's diff and Task 4's diff both touch this same, single declaration
 * rather than one renaming what the other introduced.
 */
export interface AcpAdapterDeps {}

/** Deliver to every listener even when one of them throws — same fan-out contract as ClaudePtyAdapter's. */
function fanOut<T>(listeners: ReadonlyArray<(value: T) => void>, value: T): void {
  for (const cb of listeners) {
    try {
      cb(value);
    } catch {
      // The subscriber owns its own failure; the stream keeps going.
    }
  }
}

/**
 * Translates one ACP `session/update` into the plain text `AgentProcess.onData` expects.
 * Text-bearing chunks pass through verbatim; tool-call variants become one readable
 * bracketed line — richer structured rendering (a live tool-call panel, etc.) is M6 (TUI)
 * territory, not this adapter's job (design doc §3.1, §1 non-goals).
 */
function renderSessionUpdate(update: SessionUpdate): string {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      return update.content.type === 'text' ? update.content.text : '';
    case 'tool_call':
      return `[cursor: ${update.kind ?? 'tool'} ${update.title}]\n`;
    case 'tool_call_update':
      return `[cursor: ${update.status ?? 'update'} ${update.toolCallId}]\n`;
    default:
      return '';
  }
}

class AcpProcess implements AgentProcess {
  readonly pid: number;
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number) => void> = [];
  private exitCode: number | null = null;
  private readonly child: ChildProcess;
  private readonly connection: ClientSideConnection;
  private sessionId: string | undefined;
  private readonly pendingWrites: string[] = [];

  constructor(command: string, args: string[], opts: SpawnOptions, _deps: AcpAdapterDeps) {
    this.child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    this.pid = this.child.pid ?? -1;

    this.child.on('exit', (code) => {
      this.exitCode = code ?? 0;
      fanOut(this.exitListeners, this.exitCode);
    });

    // Web Streams, not Node streams — ndJsonStream's contract (verified against the
    // SDK's own examples, not guessed): (output-we-write-to, input-we-read-from).
    const input = Writable.toWeb(this.child.stdin!);
    // `as unknown as`, not a direct `as` — Task 2 hit this exact cast rejection first:
    // `node:stream`'s `Readable.toWeb()` returns a `node:stream/web` ReadableStream, a
    // structurally distinct declaration from the global DOM-lib ReadableStream this
    // project's tsconfig resolves. TS 7.0.2 (this repo's pinned compiler) correctly
    // refuses the direct cast as "neither type sufficiently overlaps" even though the
    // two are runtime-compatible — this is the standard idiom for that case, zero
    // runtime effect (type assertions never affect emitted JS).
    const output = Readable.toWeb(this.child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const clientImpl: Client = {
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        // Stub — Task 4 replaces this with the real decideBlocked-backed decision.
        const chosen = params.options.find((o) => o.kind === 'allow_once') ?? params.options[0];
        if (chosen === undefined) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        fanOut(this.dataListeners, renderSessionUpdate(params.update));
      },
    };

    // ClientSideConnection (not the newer client({name}).connectWith(...) fluent
    // builder): the fluent builder's connectWith callback owns one single async
    // function for the whole session's lifetime, which doesn't fit an adapter whose
    // write()/onData() are called imperatively, at unpredictable times, from outside —
    // ClientSideConnection's plain async methods (initialize/newSession/prompt) do.
    this.connection = new ClientSideConnection((_agent: Agent) => clientImpl, stream);

    void (async () => {
      await this.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await this.connection.newSession({ cwd: opts.cwd, mcpServers: [] });
      this.sessionId = sessionId;
      for (const text of this.pendingWrites.splice(0)) {
        void this.connection.prompt({ sessionId, prompt: [{ type: 'text', text }] });
      }
    })();
  }

  onData(cb: (chunk: string) => void): void {
    this.dataListeners.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    if (this.exitCode !== null) cb(this.exitCode);
    else this.exitListeners.push(cb);
  }

  write(data: string): void {
    // The handshake (initialize + session/new) is async; a write() that arrives before
    // it settles is queued and flushed once `sessionId` is known, rather than dropped.
    if (this.sessionId === undefined) {
      this.pendingWrites.push(data);
      return;
    }
    void this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text: data }] });
  }

  resize(_cols: number, _rows: number): void {
    // No-op — ACP has no terminal concept.
  }

  kill(signal?: NodeJS.Signals): void {
    this.child.kill(signal);
  }
}

/**
 * Tier T1: ACP's `session/request_permission` sits below EVERY tool call the agent
 * makes — including shell execution — not just `Edit`/`Write` the way the Claude Code
 * hook's matcher does (see docs/superpowers/specs/2026-08-12-m5a-known-limitations.md).
 * That is the actual gap T1 closes over T2.
 */
export class AcpAdapter implements AgentAdapter {
  readonly kind = 'cursor';
  readonly enforcementTier: EnforcementTier = 'T1';

  constructor(
    private readonly deps: AcpAdapterDeps,
    private readonly command = 'cursor-agent',
    private readonly args: string[] = ['agent', 'acp'],
  ) {}

  spawn(opts: SpawnOptions): AgentProcess {
    return new AcpProcess(this.command, this.args, opts, this.deps);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/adapters/acp.test.ts`
Expected: all PASS. (If the PING/PONG test is flaky/slow, check that `waitFor`'s 5000ms
timeout is enough for a `bun`-spawned child on this machine — raise it rather than remove
the polling wait; ACP's handshake genuinely is multi-step-async, unlike a pty write.)

- [ ] **Step 5: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/acp.ts tests/adapters/acp.test.ts
git commit -m "feat(adapters): AcpAdapter — ACP protocol translation (T1, permission stub)

write()/onData() translate to/from session/prompt and session/update
(text passthrough, tool-call updates rendered as one readable
bracketed line — richer structured rendering is M6/TUI territory).
requestPermission is stubbed to always allow; Task 4 wires the real
decideBlocked-backed decision."
```

---

### Task 4: Wire the real permission decision into `AcpAdapter`

Replaces Task 3's always-allow `requestPermission` stub with the actual T1 enforcement:
resolve each `toolCall.locations` entry to a worktree-relative path, call `decideBlocked`
(Task 1) for each, and deny if any is blocked.

**Files:**
- Modify: `src/adapters/acp.ts`
- Modify: `tests/adapters/acp.test.ts`

**Interfaces:**
- Consumes: `decideBlocked` (Task 1, `src/radar/decision.js`), `assertContained` (existing,
  `src/core/paths.js`, throws `PATH_ESCAPE`).
- Produces: `AcpAdapterDeps` gains two fields: `resolveWorkspaceId(sessionId: string):
  string` and `decideBlocked(params: DecideBlockedParams): DecideBlockedResult`. Task 5's
  `registry.ts`/`buildMethods` wiring constructs these from daemon-internal repos.

- [ ] **Step 1: Write the failing tests**

In `tests/adapters/acp.test.ts`, add near the top (after the existing imports):

```ts
import type { DecideBlockedParams, DecideBlockedResult } from '../../src/radar/decision.js';
```

Add these tests inside `describe('AcpAdapter', ...)`, after the existing `'a tool_call/tool_call_update pair...'` test:

```ts
  it('a clean permission request (decideBlocked returns not blocked) resolves to allow', async () => {
    const decideBlocked = (): DecideBlockedResult => ({ collisions: [], blocked: false });
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:allow');
    proc.kill();
  });

  it('a blocked permission request (decideBlocked returns blocked) resolves to reject', async () => {
    const decideBlocked = (): DecideBlockedResult => ({ collisions: [], blocked: true });
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject');
    proc.kill();
  });

  it('multiple locations: ANY blocked location rejects the whole call', async () => {
    const seen: string[] = [];
    const decideBlocked = (params: DecideBlockedParams): DecideBlockedResult => {
      seen.push(params.path);
      return { collisions: [], blocked: params.path === 'b.ts' };
    };
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({
      locations: [{ path: `${process.cwd()}/a.ts` }, { path: `${process.cwd()}/b.ts` }], kind: 'edit',
    })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject');
    expect(seen).toEqual(['a.ts', 'b.ts']);
    proc.kill();
  });

  it('no locations on the tool call (e.g. an execute call the agent chose not to report): nothing to check, allowed', async () => {
    const decideBlocked = (): DecideBlockedResult => {
      throw new Error('must not be called when locations is empty');
    };
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ kind: 'execute' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:allow');
    proc.kill();
  });

  it('an unexpected internal error (decideBlocked throws) fails CLOSED, not open — T1 is the strong tier', async () => {
    const decideBlocked = (): DecideBlockedResult => {
      throw new Error('simulated internal error');
    };
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject');
    proc.kill();
  });

  it('CW_SESSION_ID missing from env: fails CLOSED (defensive — this is a wiring bug, not ordinary degradation)', async () => {
    const decideBlocked = (): DecideBlockedResult => {
      throw new Error('must not be called when there is no session id to resolve');
    };
    const adapter = new AcpAdapter(
      { resolveWorkspaceId: () => 'ws_1', decideBlocked },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject');
    proc.kill();
  });
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/adapters/acp.test.ts`
Expected: FAIL — every new test sees `PERMISSION_RESULT:allow` (the Task 3 stub always
picks `allow_once`), so the `reject`-expecting tests fail; the "must not be called" tests
may or may not fail depending on whether `decideBlocked` is even referenced yet (it isn't
used by the stub, so those pass vacuously right now — that's expected pre-Task-4 and is
not a signal of anything; Step 4 is what actually exercises them).

- [ ] **Step 3: Implement it**

In `src/adapters/acp.ts`, add these imports:

```ts
import { relative } from 'node:path';
import { realpathSync } from 'node:fs';
import { assertContained } from '../core/paths.js';
import type { DecideBlockedParams, DecideBlockedResult } from '../radar/decision.js';
```

Replace:

```ts
export interface AcpAdapterDeps {}
```

with:

```ts
export interface AcpAdapterDeps {
  resolveWorkspaceId(sessionId: string): string;
  decideBlocked(params: DecideBlockedParams): DecideBlockedResult;
}
```

Replace the `AcpProcess` constructor's `deps` parameter (currently unused, prefixed `_deps`) — find:

```ts
  constructor(command: string, args: string[], opts: SpawnOptions, _deps: AcpAdapterDeps) {
```

replace with:

```ts
  constructor(command: string, args: string[], opts: SpawnOptions, deps: AcpAdapterDeps) {
```

Replace the `requestPermission` stub — find:

```ts
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        // Stub — Task 4 replaces this with the real decideBlocked-backed decision.
        const chosen = params.options.find((o) => o.kind === 'allow_once') ?? params.options[0];
        if (chosen === undefined) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
      },
```

replace with:

```ts
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const decision = decideRequestPermission(params, opts.cwd, opts.env.CW_SESSION_ID, deps);
        const chosen = params.options.find((o) => o.kind === decision) ?? params.options[0];
        if (chosen === undefined) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
      },
```

Add this function above the `AcpProcess` class (after `renderSessionUpdate`, before `class AcpProcess`):

```ts
type PermissionDecision = 'allow_once' | 'reject_once';

/**
 * Fails CLOSED on any internal error (missing session id, decideBlocked throwing) —
 * deliberately the OPPOSITE of the Claude Code hook's fail-open posture
 * (docs/superpowers/specs/2026-08-12-m5a-known-limitations.md). The hook is a separate
 * subprocess with real daemon-unreachable/timeout failure modes it must degrade
 * through gracefully; this handler runs in-process, in the same daemon, so an error
 * here is a genuine internal bug, not legitimate unreachability — and T1 is supposed
 * to be the STRONG enforcement tier. A location outside the worktree root, or a
 * decideBlocked call that throws, denies rather than silently allowing.
 */
function decideRequestPermission(
  params: RequestPermissionRequest,
  cwd: string,
  sessionId: string | undefined,
  deps: AcpAdapterDeps,
): PermissionDecision {
  if (sessionId === undefined) return 'reject_once';

  const locations = params.toolCall.locations ?? [];
  if (locations.length === 0) return 'allow_once'; // nothing to check against

  try {
    const workspaceId = deps.resolveWorkspaceId(sessionId);
    const realCwd = realpathSync(cwd);
    for (const location of locations) {
      let relPath: string;
      try {
        relPath = relative(realCwd, assertContained(cwd, location.path));
      } catch {
        continue; // path escapes the worktree — not this adapter's problem, matches the hook's precedent
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/adapters/acp.test.ts`
Expected: all PASS.

- [ ] **Step 5: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/acp.ts tests/adapters/acp.test.ts
git commit -m "feat(adapters): AcpAdapter enforces Safe Mode over session/request_permission

Every location in a tool call is resolved to a worktree-relative
path and checked via decideBlocked (Task 1) — any blocked location
rejects the whole call. Fails CLOSED on any internal error (missing
session id, decideBlocked throwing), the deliberate opposite of the
Claude Code hook's fail-open posture: this handler runs in-process,
so an error here is a real bug, not legitimate daemon-unreachable
degradation, and T1 is supposed to be the strong tier."
```

---

### Task 5: Wire `AcpAdapter` into `createAdapter`, `buildMethods`, and lift the T1 tier gate

Makes `cw session new --agent cursor` and `cw workspace safe-mode T1` actually work.

**Files:**
- Modify: `src/adapters/registry.ts`
- Modify: `src/daemon/methods.ts`
- Modify: `src/domain/workspace.ts`
- Test: `tests/adapters/registry.test.ts` (new — this file doesn't exist yet; `createAdapter`
  is currently only exercised indirectly via `tests/adapters/claude-pty.test.ts`'s
  `describe('createAdapter', ...)` block)
- Modify: `tests/domain/workspace.test.ts`

**Interfaces:**
- Consumes: `AcpAdapter`/`AcpAdapterDeps` (Tasks 3-4, `src/adapters/acp.js`), `decideBlocked`
  (Task 1, `src/radar/decision.js`).
- Produces: `createAdapter(kind: string, deps?: AcpAdapterDeps): AgentAdapter` — `'claude'`
  unchanged, `'cursor'` returns an `AcpAdapter` (throws `ADAPTER_DEPS_MISSING` if `deps` is
  undefined), anything else still throws `UNKNOWN_AGENT`. `WorkspaceManager.setSafeMode`
  accepts `'T1'` as a normal tier from here on.

- [ ] **Step 1: Write the failing tests**

Create `tests/adapters/registry.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { createAdapter } from '../../src/adapters/registry.js';

describe('createAdapter', () => {
  it('returns the claude adapter, unaffected by cursor support', () => {
    const a = createAdapter('claude');
    expect(a.kind).toBe('claude');
    expect(a.enforcementTier).toBe('T2');
  });

  it('returns a cursor adapter with T1 when deps are provided', () => {
    const a = createAdapter('cursor', {
      resolveWorkspaceId: () => 'ws_1',
      decideBlocked: () => ({ collisions: [], blocked: false }),
    });
    expect(a.kind).toBe('cursor');
    expect(a.enforcementTier).toBe('T1');
  });

  it('throws ADAPTER_DEPS_MISSING for cursor with no deps', () => {
    expect(() => createAdapter('cursor')).toThrowError(
      expect.objectContaining({ code: 'ADAPTER_DEPS_MISSING' }) as unknown as Error,
    );
  });

  it('throws UNKNOWN_AGENT for an unsupported kind', () => {
    expect(() => createAdapter('bogus')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_AGENT' }) as unknown as Error,
    );
  });
});
```

In `tests/domain/workspace.test.ts`, find:

```ts
  it('rejects T1 with SAFE_MODE_TIER_UNAVAILABLE — no ACP adapter exists yet', () => {
    const ws = mgr.init('/tmp/projects/app');
    expect(() => mgr.setSafeMode(ws.id, 'T1')).toThrowError(
      expect.objectContaining({ code: 'SAFE_MODE_TIER_UNAVAILABLE' }) as unknown as Error,
    );
    // Unchanged — a rejected set must not partially apply.
    expect(mgr.resolve(ws.id).safeModeTier).toBe('T2');
  });
```

replace with:

```ts
  it('accepts T1, now that AcpAdapter exists', () => {
    const ws = mgr.init('/tmp/projects/app');
    const updated = mgr.setSafeMode(ws.id, 'T1');
    expect(updated.safeModeTier).toBe('T1');
    expect(mgr.resolve(ws.id).safeModeTier).toBe('T1');
  });
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/adapters/registry.test.ts`
Expected: FAIL — `createAdapter('cursor', ...)` throws `UNKNOWN_AGENT` (cursor not
registered yet), and the deps-missing/second-arg cases don't type-check yet either.

Run: `bun test tests/domain/workspace.test.ts`
Expected: FAIL — `setSafeMode(ws.id, 'T1')` still throws `SAFE_MODE_TIER_UNAVAILABLE`.

- [ ] **Step 3: Implement `src/adapters/registry.ts`**

Replace the whole file:

```ts
import { CrossweaveError } from '../core/errors.js';
import { ClaudePtyAdapter } from './claude-pty.js';
import { AcpAdapter, type AcpAdapterDeps } from './acp.js';
import type { AgentAdapter } from './types.js';

/** M5b registers Cursor via native ACP (T1). Claude Code stays on its M5a hook path (T2). */
export function createAdapter(kind: string, deps?: AcpAdapterDeps): AgentAdapter {
  if (kind === 'claude') return new ClaudePtyAdapter();
  if (kind === 'cursor') {
    if (deps === undefined) {
      throw new CrossweaveError(
        'ADAPTER_DEPS_MISSING',
        'The cursor adapter requires daemon-internal dependencies (resolveWorkspaceId, decideBlocked) that were not provided.',
      );
    }
    return new AcpAdapter(deps);
  }
  throw new CrossweaveError(
    'UNKNOWN_AGENT',
    `Unsupported agent kind: ${kind}. Supports: claude, cursor`,
  );
}
```

- [ ] **Step 4: Wire `buildMethods` to always provide the cursor deps**

In `src/daemon/methods.ts`, add this import alongside the others:

```ts
import { createAdapter } from '../adapters/registry.js';
import type { AcpAdapterDeps } from '../adapters/acp.js';
```

Find the start of `buildMethods`:

```ts
export function buildMethods(
  db: Database,
  projectRoot: string,
  adapterFactory?: AdapterFactory,
  config: CrossweaveConfig = loadConfig(projectRoot),
  opts: { startBackgroundJobs?: boolean } = {},
): Record<string, MethodHandler> {
  const workspaces = new WorkspaceManager(db);
  const sessions = new SessionManager(db, adapterFactory, config);
  const sessionsRepo = new SessionRepo(db);
```

Replace with:

```ts
export function buildMethods(
  db: Database,
  projectRoot: string,
  adapterFactory?: AdapterFactory,
  config: CrossweaveConfig = loadConfig(projectRoot),
  opts: { startBackgroundJobs?: boolean } = {},
): Record<string, MethodHandler> {
  const workspaces = new WorkspaceManager(db);
  // Constructed before `sessions` (SessionManager) deliberately: the default
  // adapterFactory closure below needs `sessionsRepo`/`fileClaims` already built —
  // both are cheap, stateless wrappers around `db`, so building them slightly earlier
  // than their other uses later in this function costs nothing.
  const sessionsRepo = new SessionRepo(db);
  const fileClaims = new FileClaimRepo(db);
  const cursorDeps: AcpAdapterDeps = {
    resolveWorkspaceId: (sessionId) => {
      const row = sessionsRepo.findById(sessionId);
      if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
      return row.workspaceId;
    },
    decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
  };
  // A caller-supplied adapterFactory (every existing test) is used AS-IS, unwrapped —
  // it's a full override, not something this daemon's cursor deps should be spliced
  // into. Only the real, no-override daemon path gets the deps-injected default.
  const sessions = new SessionManager(db, adapterFactory ?? ((kind) => createAdapter(kind, cursorDeps)), config);
```

(Note: this makes `sessions` depend on `cursorDeps`, which depends on `sessions` itself
via the `decideBlocked` closure — this is NOT a circular constructor dependency, because
`cursorDeps.decideBlocked` is a closure capturing the `sessions` binding by reference, not
reading it at closure-creation time; by the time any adapter actually CALLS it, `sessions`
has long since been assigned. This is the same "closure captures a binding assigned later
in the same function" pattern already used for `radarWatchers`/`convergenceScheduler`
elsewhere in this file — not a new idiom.)

The edit above already consumed the OLD standalone `const sessionsRepo = new SessionRepo(db);`
line (it was the last line of the "Find" block) — `sessionsRepo` now has exactly one
declaration, the moved-up one. `fileClaims` still has its ORIGINAL declaration further down
the function, now redundant since this step moved a copy above. Find it and delete it:

```ts
  const contextStore = new ContextStore(db);
  const fileClaims = new FileClaimRepo(db);
  const contracts = new ContractService(db);
```

replace with:

```ts
  const contextStore = new ContextStore(db);
  const contracts = new ContractService(db);
```

Run `grep -n "const sessionsRepo\|const fileClaims" src/daemon/methods.ts` after this step
and confirm each appears exactly ONCE in the whole file (the moved-up declaration) — if
either appears twice, delete the leftover lower one.

- [ ] **Step 5: Lift the T1 gate in `WorkspaceManager.setSafeMode`**

In `src/domain/workspace.ts`, find:

```ts
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
    // Narrows `tier` to 'T2' | 'T3' by control-flow analysis — no cast needed.
    if (tier !== 'T2' && tier !== 'T3') {
      throw new CrossweaveError('INVALID_PARAMS', `safeModeTier must be T2 or T3, got: ${tier}`);
    }
    this.workspaces.updateSafeModeTier(workspace.id, tier);
    return { ...workspace, safeModeTier: tier };
  }
```

replace with:

```ts
  /**
   * T1 became a real, acceptable tier in M5b — AcpAdapter (Cursor over native ACP) now
   * provides it. The reject-T1 gate that lived here through M5a is gone; any string
   * outside {T1, T2, T3} is still rejected.
   */
  setSafeMode(idOrName: string, tier: string): WorkspaceRow {
    const workspace = this.resolve(idOrName);
    // Narrows `tier` to 'T1' | 'T2' | 'T3' by control-flow analysis — no cast needed.
    if (tier !== 'T1' && tier !== 'T2' && tier !== 'T3') {
      throw new CrossweaveError('INVALID_PARAMS', `safeModeTier must be T1, T2 or T3, got: ${tier}`);
    }
    this.workspaces.updateSafeModeTier(workspace.id, tier);
    return { ...workspace, safeModeTier: tier };
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/adapters/registry.test.ts tests/domain/workspace.test.ts`
Expected: all PASS.

- [ ] **Step 7: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green. If any OTHER test asserts
`SAFE_MODE_TIER_UNAVAILABLE` for T1 (search: `grep -rn "SAFE_MODE_TIER_UNAVAILABLE" tests/`),
update it the same way Step 1 did — that assertion is exercising the exact gate this task
intentionally removed, not a regression.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/registry.ts src/daemon/methods.ts src/domain/workspace.ts tests/adapters/registry.test.ts tests/domain/workspace.test.ts
git commit -m "feat(adapters): wire AcpAdapter into createAdapter and buildMethods; T1 is now settable

cw session new --agent cursor and cw workspace safe-mode T1 both
work end-to-end now. WorkspaceManager.setSafeMode's M5a-era T1
rejection is lifted — a real T1 adapter exists to back the claim."
```

---

### Task 6: M5b known-limitations doc, full verification, wrap-up

**Files:**
- Create: `docs/superpowers/specs/2026-08-13-m5b-known-limitations.md`

**Interfaces:** none.

- [ ] **Step 1: Write the known-limitations doc**

Create `docs/superpowers/specs/2026-08-13-m5b-known-limitations.md`:

```markdown
# crossweave M5b — known limitations

Accepted gaps carried out of M5b (ACP client for Cursor), found and deliberately deferred
during implementation — see `docs/superpowers/specs/2026-08-13-m5b-acp-client-design.md`
for the full design this summarizes.

## Blocking quality depends on Cursor's own `locations` reporting, not crossweave

`AcpAdapter` can only check the file paths a tool call actually reports in
`toolCall.locations` — if Cursor's ACP implementation doesn't populate `locations` for a
given call (a `kind: 'execute'` shell command it chooses not to attribute to specific
files, for instance), that call has nothing to check against and is allowed
(`src/adapters/acp.ts`'s `decideRequestPermission`, "no locations on the tool call" case).

This is a materially different kind of gap than Claude Code's hook-matcher blind spot
(M5a): that one is *structurally* impossible to close (a hook cannot parse arbitrary
shell for write intent). This one is *implementation-quality* dependent on Cursor's own
ACP support, entirely outside crossweave's control, and could close — or widen — the next
time Cursor's `cursor-agent` changes how it reports tool calls, with no code change on
crossweave's side either way.

## T1 fails closed on internal errors; T2 (the Claude Code hook) fails open — deliberately different

`decideRequestPermission` denies (not allows) on any unexpected internal error — a missing
`CW_SESSION_ID`, `decideBlocked` throwing, a path resolution failure. This is the opposite
of the Claude Code hook's fail-open posture
(`docs/superpowers/specs/2026-08-12-m5a-known-limitations.md`), and the difference is
deliberate, not an inconsistency: the hook is a separate subprocess with genuine
daemon-unreachable/timeout failure modes it must degrade through gracefully; `AcpAdapter`'s
permission handler runs in-process, in the same daemon that would have to be broken for it
to fail at all — an error there is a real bug, not legitimate unreachability, and T1 is
supposed to be the strong enforcement tier.

## No Claude Code ACP bridge, no human-in-the-loop prompting, no MCP-server wiring

All three were explicitly out of scope for M5b (design doc §1) and remain so:

- Claude Code has no ACP path in crossweave — it stays on its M5a hook (T2) path. Anthropic
  has not shipped native ACP support; the only alternative is a third-party bridge
  (`@agentclientprotocol/claude-agent-acp`), deliberately not depended on for real
  enforcement (see the design doc's positioning section for the research this rests on).
- ACP's `session/request_permission` can, by protocol design, be answered as slowly as a
  client likes — crossweave doesn't use that: `AcpAdapter` always answers immediately with
  M5a's existing auto-decide policy, never pausing to ask a human. Building that UX is
  future work, not this milestone's.
- ACP's `session/new` has a native `mcpServers` field crossweave doesn't populate —
  crossweave's own per-session MCP server (`src/mcp/server.ts`) stays unconnected to any
  agent, Cursor included, exactly as it was for Claude Code before this milestone.
```

- [ ] **Step 2: Full local gate**

```bash
bun run typecheck
bun test
```

Expected: `tsc --noEmit` reports 0 errors; `bun test` reports 0 fail. If you see a
`pgrep`/stray-daemon-process-related failure in `tests/packaging/binary.test.ts`
specifically, that's a known environment artifact from leftover processes across a
session's test runs, not something this plan's changes cause — run `pgrep -fl dist/cwd`,
`kill -9` any stray PIDs found, and re-run the suite once to confirm.

- [ ] **Step 3: Confirm no other test asserts the old T1-unavailable behavior**

```bash
grep -rn "SAFE_MODE_TIER_UNAVAILABLE\|UNKNOWN_AGENT.*cursor\|M0 supports: claude" tests/ src/
```

Read through the results: every remaining `SAFE_MODE_TIER_UNAVAILABLE` reference should be
about something else entirely (garbage input, not T1 specifically) or already updated by
Task 5. `UNKNOWN_AGENT`/"M0 supports: claude" should only appear for genuinely-unsupported
kinds now, never for `'cursor'`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-13-m5b-known-limitations.md
git commit -m "docs: record M5b's known limitations"
```

- [ ] **Step 5: Final report**

No further commits in this step. Report to the user: files changed, test count,
confirmation that `bun run typecheck` and `bun test` are both clean, and that the branch is
ready for review (not merged — merging requires the user's explicit go-ahead per this
project's standing rule).

---

## Deferred (explicitly out of scope, per the approved spec §7)

- Claude Code ACP bridge.
- Structured event channel for `AgentAdapter`/`AgentProcess` — M6.
- Human-in-the-loop permission prompting.
- Wiring the per-session MCP server into `session/new`'s `mcpServers` field.
- `allow_always`/`reject_always` session-scoped memory.
