# Session hook workspace resolution Implementation Plan

> **For agentic workers:** Execute this plan inline in the current session. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Route `cw` commands from session and pane shells to the daemon that owns their session.

**Architecture:** The daemon injects its absolute repository root as `CW_WORKSPACE_ROOT` into session and pane shells. The CLI uses that value only when `CW_SESSION_ID` is also set, validates it as a Git worktree, and then connects through the existing local socket.

**Tech Stack:** Bun ≥ 1.3.13, TypeScript, `bun:sqlite`, Unix-domain sockets, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-07-session-hook-workspace-resolution-design.md`

## Global Constraints

- Zero native modules; reject dependencies that ship `.node` binaries.
- macOS and Linux only; Bun pty and Unix-domain sockets define the supported runtime.
- The daemon remains the sole owner of `.crossweave/state.db` and its socket.
- `CW_WORKSPACE_ROOT` is set by the daemon after client, launcher, and lease values.
- The CLI validates the selected root using the existing `findProjectRoot` path.

---

### Task 1: Pin workspace selection in CLI context

**Files:**
- Modify: `tests/cli/context.test.ts`
- Modify: `src/cli/context.ts`

**Interfaces:**
- Produces: `projectRootForContext(cwd: string, env: Readonly<Record<string, string | undefined>>): string`

- [x] **Step 1: Add a linked-worktree regression test**

Create a Git fixture and a clean linked worktree beneath it. Assert that a session context (`CW_SESSION_ID` and `CW_WORKSPACE_ROOT`) resolves to the fixture root, while an ordinary context resolves to the linked worktree root.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `bun test tests/cli/context.test.ts --max-concurrency=1`
Expected: FAIL because `projectRootForContext` is not exported yet.

- [x] **Step 3: Implement the resolver and use it in `withClient`**

When both session id and workspace root are present, reject a non-absolute root with `INVALID_ARGUMENTS`, then call `findProjectRoot(workspaceRoot)`. Otherwise call `findProjectRoot(cwd)`. Replace the direct `findProjectRoot(process.cwd())` call in `withClient` with this helper.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `bun test tests/cli/context.test.ts --max-concurrency=1`
Expected: PASS for session-root routing, ordinary worktree routing, and invalid relative-root refusal.

### Task 2: Inject the owning root into shells

**Files:**
- Modify: `tests/daemon/runtime.test.ts`
- Modify: `tests/daemon/methods-check.test.ts`
- Modify: `src/daemon/methods.ts`
- Modify: `tests/core/config.test.ts`
- Modify: `src/core/config.ts`

**Interfaces:**
- Consumes: Task 1's CLI context resolver.
- Produces: session shells and extra terminal panes receive `CW_WORKSPACE_ROOT` with the daemon's `projectRoot`.

- [x] **Step 1: Extend the runtime environment regression test**

In the existing lease-environment test, include `CW_WORKSPACE_ROOT` and `CW_SESSION_ID` in the command echoed by the test adapter. Assert that the value matches the Git fixture root and the started session's id.

- [x] **Step 2: Run the runtime test and verify it fails**

Run: `bun test tests/daemon/runtime.test.ts --max-concurrency=1`
Expected: the new workspace-root assertion fails while the existing lease assertions pass.

- [x] **Step 3: Inject the root and reserve its name**

Set `CW_WORKSPACE_ROOT: projectRoot` after client, launcher, and lease environment spreads in the session-start path. Add the same value to the extra terminal pane environment. Add `CW_WORKSPACE_ROOT` to `RESERVED_ENV_NAMES` and the reserved-name config test.

- [x] **Step 4: Run focused tests**

Run sequentially: `bun test tests/daemon/runtime.test.ts --max-concurrency=1`, then `bun test tests/core/config.test.ts --max-concurrency=1`.
Expected: both PASS, including the session's existing identity and lease environment assertions.

Also verify the trusted `cw check` command receives the same daemon-owned workspace root in `tests/daemon/methods-check.test.ts`.

### Task 3: Verify the hook route in the running Cockpit

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-ai-debug-loop-known-limitations.md`
- Modify: `docs/PROGRESS.md`
- Modify: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`

**Interfaces:**
- Consumes: Tasks 1–2's environment contract.
- Produces: an accurately recorded live result for `cw notify` from a session shell.

- [x] **Step 1: Start a fresh session in the disposable Cockpit project**

Use the existing scratch HOME and demo repository. Do not use any project already registered in the user's installed Cockpit.

- [x] **Step 2: Run the hook command from that session**

Run `cw notify "hook proof" --kind done` from the session shell and confirm that the owning daemon's session row carries the done signal. Also confirm the command does not create a nested `.crossweave/daemon.sock` under the session worktree.

- [x] **Step 3: Record the result and close verified limitations**

Update the AI debug-loop limitation to say that `CW_SESSION_ID` and workspace routing were live-verified. Keep unrelated outstanding CDP gaps listed until separately checked.

- [x] **Step 4: Run the repository gates**

Run `bun run typecheck`, `bun test --max-concurrency=1`, `bun run build`, and the foreground stop gate sequentially. Report any environmental unfinished result explicitly.
