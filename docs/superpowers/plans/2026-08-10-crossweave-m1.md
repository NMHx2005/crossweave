# crossweave M1 — Runtime isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each session its own port range, database, docker project and cache directory — not just its own files — and stop worktrees filling the disk. Plus close M0's carry-forward list.

**Architecture:** A `LeaseManager` owned by the daemon acquires a set of leases when a session starts and releases them when it dies, recording each in a new `lease` table. The leases become environment variables injected into the agent's pty. A `DiskGuard` tracks worktree sizes against thresholds from a committed `crossweave.config.json`, and `cw gc` reclaims worktrees belonging to dead sessions.

**Tech Stack:** TypeScript · Bun 1.3.5+ · `bun:sqlite` · `bun test` · `simple-git` · `citty`

## Global Constraints

These are inherited from M0 unchanged. Every task's requirements implicitly include them.

- **Bun >= 1.3.5.** Not Node. `bun test`, `bun:sqlite`, `Bun.spawn({terminal})`, `bun build --compile`.
- **No native RUNTIME dependency, and nothing that compiles or downloads at install time.** The rule is: no dependency may run an install script, and nothing native may reach a user. A devDependency's prebuilt binary that executes no install hook and ships in neither `dist/cw` nor `dist/cwd` does not violate it. A `.node` addon in the runtime dependency graph does. Verify with `bun pm ls` plus a check for `preinstall`/`install`/`postinstall` — not by counting packages.
- **Only two runtime dependencies are permitted: `simple-git` and `citty`.** Anything else must be built on a Bun or Web standard API.
- **POSIX only (macOS, Linux).** `package.json` declares `"os": ["darwin", "linux"]`.
- **The three runtime-specific seams stay isolated:** the pty behind `AgentAdapter`, sqlite behind the repository classes, the socket behind `node:net`. `Bun.*` appears in `src/adapters/claude-pty.ts` and nowhere else in `src/`.
- **TypeScript `strict: true`.** No `any`, no `@ts-ignore`. Non-null assertions (`!`) FORBIDDEN in `src/`, PERMITTED in `tests/`.
- **ESM only**, relative imports keep `.js` specifiers.
- **All timestamps are ISO 8601 UTC strings** (`new Date().toISOString()`), stored as `TEXT`.
- **Every path originating outside the process goes through `assertContained`.**
- **Tests are deterministic**, clean up every temp directory in a `finally`, and kill every process they start. `connectOrStart` spawns DETACHED daemons that outlive a killed run.
- Conventional Commits.

## What M0 left you

Read `docs/superpowers/specs/2026-08-10-m0-known-limitations.md` before starting — it is the source for Tasks 1–4.

The pieces you build on:

- `src/db/open.ts` — `openDatabase(dbPath)`. Migrations are a `readonly (readonly string[])[]`; each entry is a list of single statements, run inside `BEGIN IMMEDIATE` with the version read inside the transaction. **Adding a migration means appending an array and bumping `SCHEMA_VERSION`. Never edit an existing entry.**
- `src/db/repositories/{workspace,session}.ts` — `WorkspaceRepo`, `SessionRepo`. Both take a `Database` and map snake_case columns to camelCase rows. `.get()` returns `null` for a missing row.
- `src/domain/session.ts` — `SessionManager` with `create/list/resolve/rename/kill`, an injectable `adapterFactory`, `markStatus`, `clearRunning`, and an `onKill` hook the daemon sets.
- `src/daemon/runtime.ts` — `SessionRuntime`: `start(row, adapter)` returns a pid, `stop(id, graceMs)` waits for real death and escalates to SIGKILL, `subscribe`, `stopAll`.
- `src/daemon/methods.ts` — `buildMethods(db, projectRoot, adapterFactory?)`. Param guards `str`/`num`/`bool` throw `CrossweaveError('INVALID_PARAMS', …)`.
- `src/isolation/worktree.ts` — `createWorktree`, `removeWorktree`, `deleteBranch`, `listWorktreePaths`.
- `src/cli/context.ts` — `withClient`, `fail`, `currentWorkspaceId`. **Every CLI failure path must exit non-zero with exactly one `CODE: message` line on stderr.**
- `tests/helpers/git-fixture.ts` — `makeGitFixture()`, built from a template copied per test.

---

### Task 1: Reclaimable session names

M0's top carry-forward. Killing a session named `auth` leaves a `dead` row holding the name under `UNIQUE(workspace_id, name)` and a dangling `cw/auth` branch, so `cw session new --name auth` fails forever with `SESSION_NAME_TAKEN` and there is no way back short of editing SQLite.

The model this task establishes, and it must be explainable in one sentence: **the name stays taken exactly as long as the work does.**

| Command | Worktree | Branch | Row | Name reusable |
|---|---|---|---|---|
| `kill` | kept | kept | `dead` | no — the work is still there under that name |
| `kill --rm-worktree --yes` | removed | deleted | deleted | yes, immediately |
| `session rm <name> --yes` | removed | deleted | deleted | yes |

`kill` alone deliberately keeps the branch: M4's `cw land` needs it. `--rm-worktree` already means "throw this away", so deleting the row with it is consistent rather than surprising.

**Files:**
- Modify: `src/domain/session.ts` — `kill` deletes the row when the worktree is removed; new `remove` method
- Modify: `src/daemon/methods.ts` — new `session.rm` method
- Modify: `src/cli/commands/session.ts` — new `rm` subcommand
- Test: `tests/domain/session.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `SessionRepo.delete(id)` (exists, currently uncalled), `removeWorktree`, `deleteBranch`
- Produces: `SessionManager.remove(workspaceId, idOrName): Promise<void>`; RPC `session.rm`; CLI `cw session rm <target> --yes`

- [ ] **Step 1: Write the failing tests**

Append to `tests/domain/session.test.ts`:

```ts
describe('SessionManager name reclamation', () => {
  it('frees the name when the worktree is removed with the session', async () => {
    const first = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'auth', { removeWorktree: true });

    // The row is gone, not merely dead — nothing references the work any more.
    expect(sessions.list(workspaceId)).toHaveLength(0);

    const second = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    expect(second.id).not.toBe(first.id);
    expect(second.branch).toBe('cw/auth');
  });

  it('keeps the name taken while the work still exists', async () => {
    await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'auth', { removeWorktree: false });

    const row = sessions.resolve(workspaceId, 'auth');
    expect(row.status).toBe('dead');
    await expect(
      sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true }),
    ).rejects.toMatchObject({ code: 'SESSION_NAME_TAKEN' });
  });

  it('remove purges a dead session and frees its name', async () => {
    await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'auth', { removeWorktree: false });

    await sessions.remove(workspaceId, 'auth');
    expect(sessions.list(workspaceId)).toHaveLength(0);

    const { simpleGit } = await import('simple-git');
    expect((await simpleGit(fx.root).branch()).all).not.toContain('cw/auth');
    expect(await listWorktreePaths(fx.root)).toHaveLength(0);

    const revived = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    expect(revived.branch).toBe('cw/auth');
  });

  it('refuses to remove a session that is still live', async () => {
    await sessions.create({ workspaceId, name: 'live', agent: 'claude', worktree: true });
    await expect(sessions.remove(workspaceId, 'live')).rejects.toMatchObject({
      code: 'SESSION_STILL_LIVE',
    });
    expect(sessions.list(workspaceId)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/domain/session.test.ts`
Expected: FAIL — `sessions.remove is not a function`, and the first test fails because the row survives as `dead`.

- [ ] **Step 3: Change `kill` and add `remove` in `src/domain/session.ts`**

Replace the tail of `kill` (from the `ownWorktree` block onward) with:

```ts
    // A shared session points at the project root, which must never be removed.
    const ownWorktree =
      row.worktreePath !== null && row.worktreePath !== root ? row.worktreePath : null;

    if (opts.removeWorktree && ownWorktree !== null) {
      await removeWorktree(root, ownWorktree);
      if (row.branch !== null) await deleteBranch(root, row.branch).catch(() => undefined);
      // Removing the worktree means the work is gone, so nothing is left for the row
      // to describe — and keeping it would hold the name hostage under
      // UNIQUE(workspace_id, name) with no way to reclaim it.
      this.sessions.delete(row.id);
      return;
    }

    this.sessions.updateStatus(row.id, 'dead', null);
  }

  /**
   * Purge a session that has already ended: its worktree, its branch and its row.
   *
   * Refuses a live session outright rather than killing it first — deleting a running
   * agent's record without stopping the agent would strand the process, and silently
   * killing something the caller only asked to remove is worse.
   */
  async remove(workspaceId: string, idOrName: string): Promise<void> {
    const row = this.resolve(workspaceId, idOrName);
    if (row.status !== 'dead' && row.status !== 'landed') {
      throw new CrossweaveError(
        'SESSION_STILL_LIVE',
        `Session ${row.name} is ${row.status}. Kill it before removing it.`,
      );
    }

    const root = this.projectRoot(workspaceId);
    const ownWorktree =
      row.worktreePath !== null && row.worktreePath !== root ? row.worktreePath : null;

    if (ownWorktree !== null) await removeWorktree(root, ownWorktree).catch(() => undefined);
    if (row.branch !== null) await deleteBranch(root, row.branch).catch(() => undefined);
    this.sessions.delete(row.id);
  }
```

- [ ] **Step 4: Add the RPC method**

In `src/daemon/methods.ts`, beside `session.kill`:

```ts
    'session.rm': async (p) => {
      await sessions.remove(str(p, 'workspaceId'), str(p, 'idOrName'));
      return { ok: true };
    },
```

- [ ] **Step 5: Add the CLI subcommand**

In `src/cli/commands/session.ts`, in `sessionCommand`'s `subCommands`, after `kill`:

```ts
    rm: defineCommand({
      meta: { name: 'rm', description: 'Purge an ended session: its worktree, branch and record' },
      args: {
        target: { type: 'positional', description: 'Session name or id' },
        yes: { type: 'boolean', default: false, description: 'Skip confirmation' },
      },
      async run({ args }) {
        try {
          if (!args.yes) {
            throw new CrossweaveError(
              'CONFIRMATION_REQUIRED',
              'Removing a session deletes its worktree and branch. Re-run with --yes.',
            );
          }
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            await client.call('session.rm', { workspaceId, idOrName: args.target });
            process.stdout.write(`removed ${args.target}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
```

- [ ] **Step 6: Add the CLI test**

Append to `tests/cli/cli.test.ts`:

```ts
  it('session rm frees the name, and refuses without --yes', async () => {
    await cw(['init']);
    await cw(['session', 'new', '--name', 'gone', '--agent', 'claude']);
    await cw(['session', 'kill', 'gone', '--yes']);

    const refused = await cw(['session', 'rm', 'gone']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('CONFIRMATION_REQUIRED:');
    expect((await cw(['session', 'list'])).stdout).toContain('gone');

    const removed = await cw(['session', 'rm', 'gone', '--yes']);
    expect(removed.exitCode).toBe(0);
    expect((await cw(['session', 'list'])).stdout).toContain('no sessions');

    const recreated = await cw(['session', 'new', '--name', 'gone', '--agent', 'claude']);
    expect(recreated.exitCode).toBe(0);
  }, 60_000);
```

- [ ] **Step 7: Run tests and typecheck**

Run: `bun test tests/domain/session.test.ts tests/cli/cli.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

Also re-run the whole suite — Task 8 of M0 has a test asserting `kill --rm-worktree` leaves the session `dead`, and that assertion is now wrong. Update it to assert the row is gone, and say so in the commit.

- [ ] **Step 8: Commit**

```bash
git add src/domain/session.ts src/daemon/methods.ts src/cli/commands/session.ts tests/domain/session.test.ts tests/cli/cli.test.ts
git commit -m "feat(session): make a killed session's name reclaimable"
```

---

### Task 2: Guards for M0's ungarded fixes

M0's final review ran 22 mutations and seven survived. Four were closed; these are the rest. Each of these fixes is **correct in shipped code** — what is missing is a test that fails when it is reverted. That is the whole deliverable: a guard that does not fail on mutation is not a guard.

**Files:**
- Modify: `tests/client/rpc-client.test.ts` — replace the socket-`'error'` test body
- Modify: `tests/cli/cli.test.ts` — `fail()`'s `\r` handling, `cw session stop`
- Test only. No `src/` changes.

**Interfaces:**
- Consumes: `DaemonClient`, `createDaemon`, `buildMethods`, `makeGitFixture`
- Produces: nothing new

- [ ] **Step 1: Replace the socket-error test**

The existing test passes with the listener deleted, because `call()`'s `isConnected` pre-check means it never writes into a dead socket. Reaching the private socket is what makes it a real guard. In `tests/client/rpc-client.test.ts`, replace the body of `'a socket error does not escape as an uncaught exception'` with:

```ts
  it('a socket error does not escape as an uncaught exception', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);

    let uncaught: unknown;
    const onUncaught = (err: unknown): void => { uncaught = err; };
    process.once('uncaughtException', onUncaught);
    try {
      // Reach the socket directly. Going through call() cannot raise a socket
      // 'error' — its isConnected pre-check refuses to write first — which is
      // exactly why the previous version of this test passed with the listener
      // deleted.
      const socket = (client as unknown as { socket: import('node:net').Socket }).socket;
      await daemon.close();
      daemon = undefined;
      socket.write('x'.repeat(1024 * 1024));
      socket.write('y\n');
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }

    expect(uncaught).toBeUndefined();
    client.close();
  });
```

- [ ] **Step 2: Verify it is a real guard**

Delete `socket.on('error', …)` from `DaemonClient`'s constructor, run `bun test tests/client/rpc-client.test.ts`, and confirm the test **fails**. Restore the listener. Report both outcomes.

If it still passes, stop and report — do not adjust the assertion to make it fail. A reproduction that cannot distinguish the two states is worth less than an honest note that the listener is unreachable on this platform, and Linux behaves differently from macOS here (`ECONNRESET` vs EOF).

- [ ] **Step 3: Guard `fail()`'s carriage-return handling**

Append to `tests/cli/cli.test.ts`:

```ts
  // Regression: fail() collapses [\r\n] and trims. A lone \r would otherwise let a
  // wrapped subprocess error overwrite the visible line in a terminal. The existing
  // one-line assertion cannot catch it — INVALID_SESSION_NAME's message has no \r.
  it('collapses a carriage return in a wrapped error into one clean line', async () => {
    await cw(['init']);
    await cw(['session', 'new', '--name', 'crlf', '--agent', 'claude']);

    // Make `git worktree remove` fail with multi-line output by deleting the
    // worktree's .git file out from under it.
    const { rm } = await import('node:fs/promises');
    const list = await cw(['session', 'list']);
    expect(list.stdout).toContain('crlf');
    await rm(join(fx.root, '.crossweave', 'worktrees'), { recursive: true, force: true });

    const r = await cw(['session', 'kill', 'crlf', '--rm-worktree', '--yes']);
    expect(r.exitCode).toBe(1);
    const lines = r.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^[A-Z_]+: /);
    expect(r.stderr).not.toContain('\r');
    expect(r.stderr.trimEnd()).not.toMatch(/ $/);
  }, 60_000);
```

- [ ] **Step 4: Guard `cw session stop`**

Deleting the subcommand currently leaves the suite green. Append to `tests/cli/cli.test.ts`:

```ts
  it('session stop leaves the session idle and resumable', async () => {
    await cw(['init']);
    await cw(['session', 'new', '--name', 'pausable', '--agent', 'claude']);

    const help = await cw(['session', '--help']);
    expect(help.stdout).toContain('stop');

    const stopped = await cw(['session', 'stop', 'pausable']);
    expect(stopped.exitCode).toBe(0);
    expect((await cw(['session', 'list'])).stdout).toContain('idle');

    // And it is a real command, not a stub: an unknown target fails in the standard shape.
    const missing = await cw(['session', 'stop', 'ghost']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('SESSION_NOT_FOUND:');
  }, 60_000);
```

- [ ] **Step 5: Verify each new guard by mutation**

For each of the three, revert its fix, confirm the test fails, restore. Report per test, not in aggregate:

- `fail()` → `/\s*\n\s*/g` with no `.trim()`
- `cw session stop` → delete the subcommand from `sessionCommand`

- [ ] **Step 6: Run the suite and commit**

Run: `bun test && bun run typecheck`

```bash
git add tests/client/rpc-client.test.ts tests/cli/cli.test.ts
git commit -m "test: guard the M0 fixes that survived their own mutation"
```

---

### Task 3: Hygiene — the fixture leak, daemon-stop timeout, and citty's bare errors

Three small M0 carry-forwards that share no code but are each a few lines.

**Files:**
- Modify: `tests/helpers/git-fixture.ts` — remove the template on process exit
- Modify: `src/cli/index.ts` — `DAEMON_STOP_TIMEOUT`
- Modify: `src/cli/index.ts` — wrap citty's missing-positional error
- Test: `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `CrossweaveError`, `fail`
- Produces: error code `DAEMON_STOP_TIMEOUT`

- [ ] **Step 1: Stop the fixture leaking its template**

Each `bun test` process leaves one `cw-template-*` directory behind forever; 93 accumulated during M0. In `tests/helpers/git-fixture.ts`, after `template = root;`:

```ts
  // One template per process, removed when the process exits. Without this every
  // test run leaves a live git repo in TMPDIR; a full TMPDIR is what caused M0's
  // beforeEach hook timeouts in the first place.
  process.once('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort on exit; a leftover template is not worth failing a run over.
    }
  });
```

Add `rmSync` to the `node:fs` import.

**Plan/source divergence, found by this step's own mandated verification (Step 5):** the
`process.once('exit', ...)` handler above is inert under `bun test` — confirmed empirically
that Bun's test runner never fires `exit`/`beforeExit` on natural (non-`process.exit()`)
termination, even via `--preload`. It was applied as specified anyway (harmless, and correct
on a runtime that does emit `exit`), but does not close the leak under the harness this
project's own gate uses. The actual fix, race-safe against genuinely concurrent `bun test`
invocations: tag the template directory name with the owning pid
(`cw-template-${process.pid}-`) and sweep stale entries — pid confirmed dead via
`process.kill(pid, 0)` throwing `ESRCH` — at the top of `gitTemplate()`, before creating a
new template:

```ts
const TEMPLATE_NAME = /^cw-template-(\d+)-/;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function sweepStaleTemplates(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = TEMPLATE_NAME.exec(name);
    if (!match?.[1]) continue;
    const pid = Number(match[1]);
    if (isAlive(pid)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      // Best effort — another sweep or the owning process may have already removed it.
    }
  }
}
```

This means a template is swept the next time *any* process calls `gitTemplate()` after its
owner died — not the instant cleanup the exit handler imagined, but it bounds the leak
(roughly one live template per currently-running `bun test` process) instead of letting it
grow without limit, which is what the DoD line actually requires.

- [ ] **Step 2: Make `cw daemon stop` report a timeout**

It currently prints `daemon stopped` and exits 0 even when the 2 s poll expires — the exact failure it was added to prevent, now silent. In `src/cli/index.ts`, replace the poll's tail:

```ts
          const deadline = Date.now() + 2000;
          while (client.isConnected && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
          }
          client.close();
          if (Date.now() >= deadline) {
            throw new CrossweaveError(
              'DAEMON_STOP_TIMEOUT',
              'The daemon acknowledged the shutdown but was still running after 2s.',
            );
          }
          process.stdout.write('daemon stopped\n');
```

Import `CrossweaveError` in that file.

While you are here, extend the poll's existing comment: it is sound **only** because `daemon.shutdown` never calls `daemon.close()`. If shutdown ever closes client sockets before exiting, the socket closes first, the poll returns immediately and the race silently returns.

- [ ] **Step 3: Give citty's missing-positional error a `CODE:` prefix**

`cw session stop` with no target exits 1 but prints citty's own `Missing required positional argument: TARGET`, with no prefix — against the DoD's contract that every error path emits one `CODE: message` line.

**Find out how citty actually reports this before writing the fix.** It may reject the promise `runMain` returns, or it may write to stderr and call `process.exit` itself, in which case catching the rejection does nothing. Run `cw session stop` with no argument and check whether a `.catch` on `runMain` ever fires. Report what you observe.

If it rejects, wrapping is enough:

```ts
void runMain(main).catch((err: unknown) => {
  // Anything reaching here is an argument error: every command already funnels its
  // own failures through fail() inside its try/catch.
  fail(
    err instanceof CrossweaveError
      ? err
      : new CrossweaveError('INVALID_ARGUMENTS', String((err as Error).message ?? err)),
  );
});
```

If citty exits on its own instead, do NOT fight it — validate the positional yourself inside the command's `run` and throw `CrossweaveError('INVALID_ARGUMENTS', …)`, declaring the arg optional so citty passes it through. Say which route you took and why.

- [ ] **Step 4: Write the tests**

Append to `tests/cli/cli.test.ts`:

```ts
  it('a missing required argument reports in the standard shape', async () => {
    await cw(['init']);
    const r = await cw(['session', 'stop']);
    expect(r.exitCode).toBe(1);
    const lines = r.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^[A-Z_]+: /);
  }, 30_000);
```

- [ ] **Step 5: Verify the fixture fix**

Count `cw-template-*` directories in `$TMPDIR`, run `bun test` three times, count again. The count must not grow. Report both numbers.

- [ ] **Step 6: Run the suite and commit**

Run: `bun test && bun run typecheck`

```bash
git add tests/helpers/git-fixture.ts src/cli/index.ts tests/cli/cli.test.ts
git commit -m "fix: stop the fixture leaking, report a stop timeout, prefix argument errors"
```

---

### Task 4: Delete the dead exports

Five symbols were introduced by a task and abandoned by a later fix. Leaving them invites a future caller to use the wrong one — `WorkspaceRepo.findByName` in particular is exactly the ambiguous lookup that `WorkspaceManager.resolve` was rewritten to avoid.

**Files:**
- Modify: `src/db/repositories/workspace.ts` — remove `findByName`
- Modify: `src/isolation/worktree.ts` — remove `listWorktreePaths` **only if** Task 1 did not start using it
- Modify: `src/core/ids.ts`, `src/daemon/rpc.ts` — remove unused exports
- Modify: the tests that reference them

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Confirm each is genuinely dead**

For each of `WorkspaceRepo.findByName`, `listWorktreePaths`, `SessionRepo.delete`, `IdPrefix`, `RpcRequest`, run:

```bash
grep -rn "<symbol>" src/ tests/
```

This list is from M0's review and is **already out of date by the time you reach it** — that is the point of running the greps rather than trusting it:

- `SessionRepo.delete` — Task 1 added callers. **Keep.**
- `listWorktreePaths` — Task 11's gc calls it to sweep orphaned worktrees. **Keep.**
- `SessionRepo.findByWorktreePath` — added by Task 11, so it will exist by then. **Keep.**

Report what you actually find for each symbol. If a grep contradicts this list, the grep is right.

- [ ] **Step 2: Remove the ones with no caller at all**

Delete `WorkspaceRepo.findByName` and its test. Delete any exported type nothing imports.

Do NOT delete anything a test still uses without also deleting that test — and if the test is meaningful, that is a signal the symbol should stay.

- [ ] **Step 3: Run the suite and commit**

Run: `bun test && bun run typecheck`

```bash
git add -A
git commit -m "refactor: delete exports abandoned by later fixes"
```

---

### Task 5: Config file

M1's thresholds and ranges have to come from somewhere the user controls, and the spec already names the file. It is committed to the repo, unlike `.crossweave/`.

**Files:**
- Create: `src/core/config.ts`
- Test: `tests/core/config.test.ts`

**Interfaces:**
- Consumes: `CrossweaveError`, `crossweaveDir` is NOT used — the config lives at the project root
- Produces:
  - `interface CrossweaveConfig { ports: { base: number; blockSize: number; named: Record<string, number> }; disk: { perSessionBytes: number; perWorkspaceBytes: number }; db: { strategy: 'none' | 'schema' | 'file-copy'; url?: string }; cacheIsolation: boolean }`
  - `DEFAULT_CONFIG: CrossweaveConfig`
  - `loadConfig(projectRoot: string): CrossweaveConfig`

- [ ] **Step 1: Write the failing test**

Create `tests/core/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../../src/core/config.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cw-config-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  it('merges a partial file over the defaults', async () => {
    await writeFile(
      join(dir, 'crossweave.config.json'),
      JSON.stringify({ ports: { base: 50000 }, disk: { perSessionBytes: 1024 } }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.ports.base).toBe(50000);
    // Untouched keys keep their defaults rather than becoming undefined.
    expect(cfg.ports.blockSize).toBe(DEFAULT_CONFIG.ports.blockSize);
    expect(cfg.disk.perSessionBytes).toBe(1024);
    expect(cfg.disk.perWorkspaceBytes).toBe(DEFAULT_CONFIG.disk.perWorkspaceBytes);
  });

  it('rejects malformed JSON with a usable message', async () => {
    await writeFile(join(dir, 'crossweave.config.json'), '{ not json');
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }) as unknown as Error,
    );
  });

  it('rejects a port base that cannot hold a block', async () => {
    await writeFile(
      join(dir, 'crossweave.config.json'),
      JSON.stringify({ ports: { base: 65530, blockSize: 10 } }),
    );
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }) as unknown as Error,
    );
  });

  it('rejects a db strategy it does not implement', async () => {
    await writeFile(
      join(dir, 'crossweave.config.json'),
      JSON.stringify({ db: { strategy: 'branch' } }),
    );
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }) as unknown as Error,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/config.test.ts`
Expected: FAIL — cannot resolve `../../src/core/config.js`.

- [ ] **Step 3: Implement `src/core/config.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CrossweaveError } from './errors.js';

export interface CrossweaveConfig {
  ports: { base: number; blockSize: number; named: Record<string, number> };
  disk: { perSessionBytes: number; perWorkspaceBytes: number };
  db: { strategy: 'none' | 'schema' | 'file-copy'; url?: string };
  cacheIsolation: boolean;
}

export const DEFAULT_CONFIG: CrossweaveConfig = {
  ports: { base: 43000, blockSize: 10, named: {} },
  // 2 GB per session, 20 GB per workspace. A 2 GB checkout consumed 9.8 GB of
  // worktrees in 20 minutes in the reports this project was designed against, so
  // these are deliberately not generous.
  disk: { perSessionBytes: 2 * 1024 * 1024 * 1024, perWorkspaceBytes: 20 * 1024 * 1024 * 1024 },
  db: { strategy: 'none' },
  cacheIsolation: true,
};

const STRATEGIES = new Set(['none', 'schema', 'file-copy']);

function invalid(detail: string): never {
  throw new CrossweaveError('CONFIG_INVALID', `crossweave.config.json: ${detail}`);
}

/**
 * Merged one level deep over the defaults, deliberately. A user writing
 * `{"ports": {"base": 50000}}` means "change the base", not "and blow away
 * blockSize and named" — a plain spread would do the latter silently.
 */
export function loadConfig(projectRoot: string): CrossweaveConfig {
  const path = join(projectRoot, 'crossweave.config.json');
  if (!existsSync(path)) return DEFAULT_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    invalid(`could not be parsed: ${(cause as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) invalid('must contain a JSON object');
  const input = raw as Partial<CrossweaveConfig>;

  const config: CrossweaveConfig = {
    ports: { ...DEFAULT_CONFIG.ports, ...input.ports },
    disk: { ...DEFAULT_CONFIG.disk, ...input.disk },
    db: { ...DEFAULT_CONFIG.db, ...input.db },
    cacheIsolation: input.cacheIsolation ?? DEFAULT_CONFIG.cacheIsolation,
  };

  if (!Number.isInteger(config.ports.base) || config.ports.base < 1024) {
    invalid(`ports.base must be an integer >= 1024, got ${String(config.ports.base)}`);
  }
  if (!Number.isInteger(config.ports.blockSize) || config.ports.blockSize < 1) {
    invalid(`ports.blockSize must be a positive integer, got ${String(config.ports.blockSize)}`);
  }
  if (config.ports.base + config.ports.blockSize > 65535) {
    invalid(`ports.base ${config.ports.base} + blockSize ${config.ports.blockSize} exceeds 65535`);
  }
  if (config.disk.perSessionBytes < 1 || config.disk.perWorkspaceBytes < 1) {
    invalid('disk limits must be positive');
  }
  if (!STRATEGIES.has(config.db.strategy)) {
    invalid(
      `db.strategy must be one of ${[...STRATEGIES].join(', ')}, got ${String(config.db.strategy)}`,
    );
  }

  return config;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/core/config.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts tests/core/config.test.ts
git commit -m "feat(config): add crossweave.config.json with validated defaults"
```

---

### Task 6: The lease table

**Files:**
- Modify: `src/db/schema.ts` — migration 2, `SCHEMA_VERSION` → 2
- Create: `src/db/repositories/lease.ts`
- Test: `tests/db/lease-repo.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, `newId`
- Produces:
  - `type LeaseKind = 'port' | 'db' | 'docker' | 'cache'`
  - `interface LeaseRow { id: string; sessionId: string; kind: LeaseKind; value: string; acquiredAt: string; releasedAt: string | null }`
  - `class LeaseRepo` with `insert(row)`, `listBySession(sessionId)`, `listActive(kind)`, `release(sessionId)`, `releaseAll()`

- [ ] **Step 1: Write the failing test**

Create `tests/db/lease-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseRepo, type LeaseRow } from '../../src/db/repositories/lease.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let leases: LeaseRepo;
let sessionId: string;

function makeLease(overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    id: newId('ev'),
    sessionId,
    kind: 'port',
    value: '43000',
    acquiredAt: '2026-08-10T00:00:00.000Z',
    releasedAt: null,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-lease-'));
  db = openDatabase(join(dir, 'state.db'));
  const workspaceId = newId('ws');
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
  leases = new LeaseRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('LeaseRepo', () => {
  it('round-trips a lease', () => {
    const row = makeLease();
    leases.insert(row);
    expect(leases.listBySession(sessionId)).toEqual([row]);
  });

  it('listActive excludes released leases and other kinds', () => {
    leases.insert(makeLease({ value: '43000' }));
    leases.insert(makeLease({ id: newId('ev'), kind: 'cache', value: '/tmp/c' }));
    const released = makeLease({ id: newId('ev'), value: '43010' });
    leases.insert(released);
    leases.release(sessionId);

    expect(leases.listActive('port')).toHaveLength(0);

    const fresh = makeLease({ id: newId('ev'), value: '43020' });
    leases.insert(fresh);
    expect(leases.listActive('port').map((l) => l.value)).toEqual(['43020']);
  });

  it('release is idempotent and stamps a time', () => {
    leases.insert(makeLease());
    leases.release(sessionId);
    const after = leases.listBySession(sessionId);
    expect(after[0]?.releasedAt).not.toBeNull();
    const stamp = after[0]?.releasedAt;
    leases.release(sessionId);
    expect(leases.listBySession(sessionId)[0]?.releasedAt).toBe(stamp ?? '');
  });

  it('releaseAll clears every outstanding lease', () => {
    leases.insert(makeLease());
    leases.insert(makeLease({ id: newId('ev'), kind: 'docker', value: 'cw_x' }));
    leases.releaseAll();
    expect(leases.listActive('port')).toHaveLength(0);
    expect(leases.listActive('docker')).toHaveLength(0);
  });

  it('cascades when the session is deleted', () => {
    leases.insert(makeLease());
    new SessionRepo(db).delete(sessionId);
    expect(leases.listBySession(sessionId)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/lease-repo.test.ts`
Expected: FAIL — cannot resolve `../../src/db/repositories/lease.js`.

- [ ] **Step 3: Add a `lease` id prefix**

In `src/core/ids.ts`, extend the union:

```ts
export type IdPrefix = 'ws' | 's' | 'ev' | 'msg' | 'lease';
```

The tests above use `newId('ev')` as a placeholder — **change them to `newId('lease')`** when you implement this. `'ev'` belongs to M2's event ledger, and reusing it here would make those ids ambiguous the moment the ledger lands.

- [ ] **Step 4: Add migration 2 to `src/db/schema.ts`**

Bump the version and **append** a new entry. Do not edit migration 1 — a database created by M0 must migrate forward, not be rebuilt.

```ts
export const SCHEMA_VERSION = 2;
```

Append to `MIGRATIONS`:

```ts
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
```

- [ ] **Step 5: Implement `src/db/repositories/lease.ts`**

```ts
import type { Database } from 'bun:sqlite';

export type LeaseKind = 'port' | 'db' | 'docker' | 'cache';

export interface LeaseRow {
  id: string;
  sessionId: string;
  kind: LeaseKind;
  value: string;
  acquiredAt: string;
  releasedAt: string | null;
}

interface LeaseRecord {
  id: string;
  session_id: string;
  kind: string;
  value: string;
  acquired_at: string;
  released_at: string | null;
}

const COLUMNS = 'id, session_id, kind, value, acquired_at, released_at';

function toRow(r: LeaseRecord): LeaseRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind as LeaseKind,
    value: r.value,
    acquiredAt: r.acquired_at,
    releasedAt: r.released_at,
  };
}

export class LeaseRepo {
  constructor(private readonly db: Database) {}

  insert(row: LeaseRow): void {
    this.db
      .prepare(`INSERT INTO lease (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.sessionId, row.kind, row.value, row.acquiredAt, row.releasedAt);
  }

  listBySession(sessionId: string): LeaseRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM lease WHERE session_id = ? ORDER BY acquired_at ASC, id ASC`)
      .all(sessionId) as LeaseRecord[];
    return rows.map(toRow);
  }

  /** Outstanding leases of one kind — what the allocator must avoid colliding with. */
  listActive(kind: LeaseKind): LeaseRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM lease WHERE kind = ? AND released_at IS NULL`)
      .all(kind) as LeaseRecord[];
    return rows.map(toRow);
  }

  /** Idempotent: a lease already released keeps its original timestamp. */
  release(sessionId: string): void {
    this.db
      .prepare('UPDATE lease SET released_at = ? WHERE session_id = ? AND released_at IS NULL')
      .run(new Date().toISOString(), sessionId);
  }

  /** Used on daemon start: nothing this process holds can have survived its death. */
  releaseAll(): void {
    this.db
      .prepare('UPDATE lease SET released_at = ? WHERE released_at IS NULL')
      .run(new Date().toISOString());
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test tests/db/lease-repo.test.ts && bun run typecheck`

Then run the WHOLE suite. Migration 2 must apply cleanly to a database created at version 1 — if any existing test opens a v1 database, this is where it breaks.

- [ ] **Step 7: Add a migration test**

Append to `tests/db/open.test.ts`:

```ts
  it('migrates a v1 database forward without rebuilding it', () => {
    const p = join(dir, 'state.db');
    const db1 = openDatabase(p);
    db1.run("INSERT INTO workspace (id, name, root_path, created_at, default_isolation, safe_mode_tier) VALUES ('ws_1','demo','/tmp/x','2026-08-10T00:00:00.000Z','worktree','T3')");
    db1.close();

    const db2 = openDatabase(p);
    // The pre-existing row survived, and the new table exists.
    const ws = db2.query('SELECT count(*) AS n FROM workspace').get() as { n: number };
    expect(ws.n).toBe(1);
    const lease = db2.query('SELECT count(*) AS n FROM lease').get() as { n: number };
    expect(lease.n).toBe(0);
    db2.close();
  });
```

This is weaker than it looks — both opens run the same build, so it proves migrations are idempotent rather than that a genuine v1 file upgrades. Say so in your report; a real v1 fixture is worth adding when M2 introduces migration 3.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/repositories/lease.ts tests/db/lease-repo.test.ts tests/db/open.test.ts
git commit -m "feat(db): add the lease table and repository"
```

---

### Task 7: Port lease allocation

The first real lease, and the one with a genuine allocation problem: two sessions must never get the same block, and a port another process on the machine already holds is not ours to hand out.

**Files:**
- Create: `src/isolation/leases/ports.ts`
- Test: `tests/isolation/ports.test.ts`

**Interfaces:**
- Consumes: `LeaseRepo`, `CrossweaveConfig`, `CrossweaveError`
- Produces: `allocatePortBlock(leases: LeaseRepo, config: CrossweaveConfig): Promise<number>` — returns the base port of a free contiguous block

- [ ] **Step 1: Write the failing test**

Create `tests/isolation/ports.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseRepo } from '../../src/db/repositories/lease.js';
import { allocatePortBlock } from '../../src/isolation/leases/ports.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let leases: LeaseRepo;
let sessionId: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-ports-'));
  db = openDatabase(join(dir, 'state.db'));
  const workspaceId = newId('ws');
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
  leases = new LeaseRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('allocatePortBlock', () => {
  it('returns the configured base when nothing is taken', async () => {
    expect(await allocatePortBlock(leases, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.ports.base);
  });

  it('skips a block already leased', async () => {
    leases.insert({
      id: newId('ev'), sessionId, kind: 'port', value: String(DEFAULT_CONFIG.ports.base),
      acquiredAt: '2026-08-10T00:00:00.000Z', releasedAt: null,
    });
    expect(await allocatePortBlock(leases, DEFAULT_CONFIG)).toBe(
      DEFAULT_CONFIG.ports.base + DEFAULT_CONFIG.ports.blockSize,
    );
  });

  it('reuses a block whose lease was released', async () => {
    leases.insert({
      id: newId('ev'), sessionId, kind: 'port', value: String(DEFAULT_CONFIG.ports.base),
      acquiredAt: '2026-08-10T00:00:00.000Z', releasedAt: null,
    });
    leases.release(sessionId);
    expect(await allocatePortBlock(leases, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.ports.base);
  });

  // A lease table free of a port does not make the port free: another program on the
  // machine may hold it, and handing it to an agent produces an EADDRINUSE the user
  // cannot explain.
  it('skips a block whose first port is held by another process', async () => {
    const base = DEFAULT_CONFIG.ports.base;
    const squatter = createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(base, '127.0.0.1', () => resolve());
    });
    try {
      expect(await allocatePortBlock(leases, DEFAULT_CONFIG)).toBe(
        base + DEFAULT_CONFIG.ports.blockSize,
      );
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it('throws when the range is exhausted', async () => {
    const tiny = {
      ...DEFAULT_CONFIG,
      ports: { base: 43000, blockSize: 10, named: {} },
    };
    // Fill every block the range can hold by leasing them all.
    for (let p = 43000; p + 10 <= 65535; p += 10) {
      leases.insert({
        id: newId('ev'), sessionId, kind: 'port', value: String(p),
        acquiredAt: '2026-08-10T00:00:00.000Z', releasedAt: null,
      });
    }
    await expect(allocatePortBlock(leases, tiny)).rejects.toMatchObject({
      code: 'NO_PORTS_AVAILABLE',
    });
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/isolation/ports.test.ts`
Expected: FAIL — cannot resolve `../../src/isolation/leases/ports.js`.

- [ ] **Step 3: Implement `src/isolation/leases/ports.ts`**

```ts
import { createServer } from 'node:net';
import { CrossweaveError } from '../../core/errors.js';
import type { CrossweaveConfig } from '../../core/config.js';
import type { LeaseRepo } from '../../db/repositories/lease.js';

/** True when nothing on the loopback interface currently holds this port. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Find a free contiguous block and return its base port.
 *
 * Two conditions have to hold, and the lease table only covers the first: no other
 * session may hold the block, AND the machine must not already be using it. A port
 * absent from the table is not necessarily free — some unrelated program may own it,
 * and handing it to an agent produces an EADDRINUSE the user has no way to explain.
 *
 * Only the block's first port is probed. Probing all ten would triple the cost of
 * starting a session for a case that does not occur in practice, since blocks are
 * handed out whole.
 */
export async function allocatePortBlock(
  leases: LeaseRepo,
  config: CrossweaveConfig,
): Promise<number> {
  const taken = new Set(leases.listActive('port').map((l) => Number(l.value)));
  const { base, blockSize } = config.ports;

  for (let candidate = base; candidate + blockSize <= 65536; candidate += blockSize) {
    if (taken.has(candidate)) continue;
    if (await isPortFree(candidate)) return candidate;
  }

  throw new CrossweaveError(
    'NO_PORTS_AVAILABLE',
    `No free port block of ${blockSize} between ${base} and 65535. ` +
      `${taken.size} block(s) are leased; run \`cw gc\` if sessions have ended.`,
  );
}
```

**Plan/source divergence, found by the final whole-branch review, DoD-breaking:** the code
above has a real race across *different* sessions that the code as written does not close.
`taken` is snapshotted once, then `await isPortFree(candidate)` yields — the daemon
dispatches RPCs unserialized, and the winning candidate's lease row is not inserted until
`LeaseManager.acquire`/`record`, later still. Two different sessions can both pass the same
candidate through `isPortFree` before either lease row lands. Reproduced deterministically
(40/40 trials collided with a squatter on the first candidate and staggered timing) and
confirmed at the real daemon+pty level by echoing `$CW_PORT_BASE` from inside two
concurrently-started agents — the exact method the DoD requires. This directly falsified the
DoD's headline claim ("two sessions started at once get different `CW_PORT_BASE` values").

The fix, verified to take 40/40 collisions to 0/40: re-read the active set immediately after
the probe resolves, before committing to the candidate. This is a valid check-then-act
specifically because the caller (`LeaseManager.acquire`) inserts the row with **no `await`**
between the return and the insert — nothing can interleave in that gap.

```ts
    if (await isPortFree(candidate)) {
      // Re-read: another acquire may have inserted its row while we were probing —
      // the snapshot above is now stale. The caller inserts with no `await` after this
      // returns, so nothing can interleave between this check and that write.
      for (const lease of leases.listActive('port')) taken.add(Number(lease.value));
      if (taken.has(candidate)) continue;
      return candidate;
    }
```

Guarding this requires a concurrent test with a squatter on the first candidate — without
one, the race does not reproduce and a naive concurrent test passes against the broken code.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/isolation/ports.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/isolation/leases/ports.ts tests/isolation/ports.test.ts
git commit -m "feat(leases): allocate a free contiguous port block per session"
```

---

### Task 8: The Lease Manager

Ties the four lease kinds together into one acquire/release pair and turns them into the environment an agent is spawned with. This is what makes M1's claim — isolating *runtime*, not just files — true.

**Files:**
- Create: `src/isolation/leases/manager.ts`
- Test: `tests/isolation/lease-manager.test.ts`

**Interfaces:**
- Consumes: `LeaseRepo`, `allocatePortBlock`, `CrossweaveConfig`, `newId`, `crossweaveDir`
- Produces:
  - `class LeaseManager` — constructor `(db: Database, projectRoot: string, config: CrossweaveConfig)`
  - `acquire(sessionId: string): Promise<Record<string, string>>` — returns the env to inject
  - `release(sessionId: string): void`
  - `releaseAll(): void`

- [ ] **Step 1: Write the failing test**

Create `tests/isolation/lease-manager.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseRepo } from '../../src/db/repositories/lease.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let manager: LeaseManager;
let sessionA: string;
let sessionB: string;

function addSession(workspaceId: string, name: string): string {
  const id = newId('s');
  new SessionRepo(db).insert({
    id, workspaceId, name, agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: null, branch: null,
    createdAt: '2026-08-10T00:00:00.000Z', lastActiveAt: '2026-08-10T00:00:00.000Z',
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  return id;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-leasemgr-'));
  db = openDatabase(join(dir, '.crossweave', 'state.db'));
  const workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: dir,
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
  sessionA = addSession(workspaceId, 'a');
  sessionB = addSession(workspaceId, 'b');
  manager = new LeaseManager(db, dir, DEFAULT_CONFIG);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('LeaseManager', () => {
  it('injects a port block, a docker project and a cache directory', async () => {
    const env = await manager.acquire(sessionA);

    expect(Number(env.CW_PORT_BASE)).toBe(DEFAULT_CONFIG.ports.base);
    expect(env.PORT).toBe(env.CW_PORT_BASE);
    expect(env.COMPOSE_PROJECT_NAME).toBe(`cw_${sessionA}`);
    expect(env.XDG_CACHE_HOME).toContain(sessionA);
    expect(existsSync(env.XDG_CACHE_HOME ?? '')).toBe(true);
  });

  it('gives two concurrent sessions non-overlapping ports and caches', async () => {
    const a = await manager.acquire(sessionA);
    const b = await manager.acquire(sessionB);

    expect(a.CW_PORT_BASE).not.toBe(b.CW_PORT_BASE);
    expect(Math.abs(Number(a.CW_PORT_BASE) - Number(b.CW_PORT_BASE)))
      .toBeGreaterThanOrEqual(DEFAULT_CONFIG.ports.blockSize);
    expect(a.XDG_CACHE_HOME).not.toBe(b.XDG_CACHE_HOME);
    expect(a.COMPOSE_PROJECT_NAME).not.toBe(b.COMPOSE_PROJECT_NAME);
  });

  it('exposes named ports as offsets from the block base', async () => {
    const config = {
      ...DEFAULT_CONFIG,
      ports: { ...DEFAULT_CONFIG.ports, named: { API_PORT: 0, DB_PORT: 1 } },
    };
    const named = new LeaseManager(db, dir, config);
    const env = await named.acquire(sessionA);
    expect(Number(env.API_PORT)).toBe(Number(env.CW_PORT_BASE));
    expect(Number(env.DB_PORT)).toBe(Number(env.CW_PORT_BASE) + 1);
  });

  it('releases everything, freeing the block for reuse', async () => {
    const a = await manager.acquire(sessionA);
    manager.release(sessionA);
    const b = await manager.acquire(sessionB);
    expect(b.CW_PORT_BASE).toBe(a.CW_PORT_BASE);
  });

  it('records one lease row per kind', async () => {
    await manager.acquire(sessionA);
    const kinds = new LeaseRepo(db).listBySession(sessionA).map((l) => l.kind).sort();
    expect(kinds).toEqual(['cache', 'docker', 'port']);
  });

  it('does not set DATABASE_URL under the default none strategy', async () => {
    const env = await manager.acquire(sessionA);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('sets DATABASE_URL under the file-copy strategy', async () => {
    const config = { ...DEFAULT_CONFIG, db: { strategy: 'file-copy' as const, url: 'app.db' } };
    const withDb = new LeaseManager(db, dir, config);
    const env = await withDb.acquire(sessionA);
    expect(env.DATABASE_URL).toContain(sessionA);
    expect(new LeaseRepo(db).listBySession(sessionA).map((l) => l.kind)).toContain('db');
  });

  it('releaseAll clears leases left by a previous daemon', async () => {
    await manager.acquire(sessionA);
    manager.releaseAll();
    const env = await manager.acquire(sessionB);
    expect(env.CW_PORT_BASE).toBe(String(DEFAULT_CONFIG.ports.base));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/isolation/lease-manager.test.ts`
Expected: FAIL — cannot resolve `../../src/isolation/leases/manager.js`.

- [ ] **Step 3: Implement `src/isolation/leases/manager.ts`**

```ts
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { newId } from '../../core/ids.js';
import { crossweaveDir } from '../../core/paths.js';
import type { CrossweaveConfig } from '../../core/config.js';
import { LeaseRepo, type LeaseKind } from '../../db/repositories/lease.js';
import { allocatePortBlock } from './ports.js';

/**
 * Acquires everything a session needs that is NOT its filesystem, and hands it back
 * as the environment its agent is spawned with.
 *
 * Worktrees isolate files. They do not isolate the port a dev server binds, the
 * database it migrates, the docker project it brings up, or the build cache it
 * writes — all of which are shared by default, and all of which two agents will
 * fight over silently.
 */
export class LeaseManager {
  private readonly leases: LeaseRepo;

  constructor(
    db: Database,
    private readonly projectRoot: string,
    private readonly config: CrossweaveConfig,
  ) {
    this.leases = new LeaseRepo(db);
  }

  private record(sessionId: string, kind: LeaseKind, value: string): void {
    this.leases.insert({
      id: newId('ev'),
      sessionId,
      kind,
      value,
      acquiredAt: new Date().toISOString(),
      releasedAt: null,
    });
  }

  async acquire(sessionId: string): Promise<Record<string, string>> {
    const env: Record<string, string> = {};

    const base = await allocatePortBlock(this.leases, this.config);
    this.record(sessionId, 'port', String(base));
    env.CW_PORT_BASE = String(base);
    env.PORT = String(base);
    for (const [name, offset] of Object.entries(this.config.ports.named)) {
      env[name] = String(base + offset);
    }

    const project = `cw_${sessionId}`;
    this.record(sessionId, 'docker', project);
    env.COMPOSE_PROJECT_NAME = project;

    if (this.config.cacheIsolation) {
      const cache = join(crossweaveDir(this.projectRoot), 'cache', sessionId);
      mkdirSync(cache, { recursive: true });
      this.record(sessionId, 'cache', cache);
      env.XDG_CACHE_HOME = cache;
    }

    const url = this.acquireDatabase(sessionId);
    if (url !== undefined) env.DATABASE_URL = url;

    return env;
  }

  /**
   * `none` is the default because guessing wrong is worse than doing nothing: pointing
   * an agent at a database that does not exist breaks it, and pointing it at the
   * shared one is the problem this whole layer exists to solve.
   */
  private acquireDatabase(sessionId: string): string | undefined {
    if (this.config.db.strategy === 'none') return undefined;

    if (this.config.db.strategy === 'file-copy') {
      const source = this.config.db.url ?? 'app.db';
      const target = join(crossweaveDir(this.projectRoot), 'db', `${sessionId}.db`);
      mkdirSync(join(crossweaveDir(this.projectRoot), 'db'), { recursive: true });
      const from = join(this.projectRoot, source);
      if (existsSync(from)) copyFileSync(from, target);
      this.record(sessionId, 'db', target);
      return target;
    }

    // Plan/source divergence, found by task review, security: `source` above comes
    // straight from `crossweave.config.json`'s `db.url` — external, unvalidated input —
    // and `from` never went through `assertContained`. A traversal `db.url` (e.g.
    // `../../../../etc/passwd`) resolved `from` outside `projectRoot`, and that file
    // was then copied into the session's db-copy target and wired into the agent's
    // environment via `DATABASE_URL`: an arbitrary-file-read-into-agent-workspace
    // primitive. Fixed by routing `from` through `assertContained(this.projectRoot,
    // from)` before `existsSync`/`copyFileSync` — `join(this.projectRoot, source)`
    // above must become `assertContained(this.projectRoot, source)` instead, per the
    // Global Constraint that every path originating outside the process goes through
    // `assertContained`.

    // schema: the session gets its own Postgres schema via the search_path, leaving
    // the connection URL itself untouched.
    const schema = `cw_${sessionId}`;
    this.record(sessionId, 'db', schema);
    const url = this.config.db.url ?? '';
    return url === '' ? undefined : `${url}${url.includes('?') ? '&' : '?'}options=-csearch_path%3D${schema}`;
  }

  release(sessionId: string): void {
    this.leases.release(sessionId);
  }

  /** Nothing a previous daemon held can have survived its death. */
  releaseAll(): void {
    this.leases.releaseAll();
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/isolation/lease-manager.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/isolation/leases/manager.ts tests/isolation/lease-manager.test.ts
git commit -m "feat(leases): acquire ports, docker project, cache and database per session"
```

---

### Task 9: Wire leases into the session lifecycle

**Files:**
- Modify: `src/daemon/runtime.ts` — `start` takes an env
- Modify: `src/daemon/methods.ts` — acquire on start, release on stop/kill, `releaseAll` on boot
- Modify: `src/daemon/main.ts` — load the config
- Test: `tests/daemon/runtime.test.ts`

**Interfaces:**
- Consumes: `LeaseManager`, `loadConfig`
- Produces: `SessionRuntime.start(session, adapter, env)` — the third parameter is new

- [ ] **Step 1: Write the failing test**

Append to `tests/daemon/runtime.test.ts`, inside the `session runtime` describe:

```ts
  it('injects the session\'s leases into the agent environment', async () => {
    await client.call('session.new', { workspaceId, name: 'leased', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'leased' });

    let seen = '';
    client.onNotification((method, params) => {
      if (method === 'session.data') seen += (params as { chunk: string }).chunk;
    });
    await client.call('session.attach', { workspaceId, idOrName: 'leased' });
    await client.call('session.input', {
      workspaceId, idOrName: 'leased', data: 'echo "P=$CW_PORT_BASE D=$COMPOSE_PROJECT_NAME"\n',
    });

    await waitFor(() => seen.includes('P=') && seen.includes('D=cw_'));
    expect(seen).toMatch(/P=\d{4,5}/);
    expect(seen).toContain('D=cw_s_');
  }, 20_000);

  it('frees a session\'s leases when it stops, so the next session reuses them', async () => {
    await client.call('session.new', { workspaceId, name: 'first', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'first' });
    await client.call('session.stop', { workspaceId, idOrName: 'first' });

    await client.call('session.new', { workspaceId, name: 'second', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'second' });

    const leases = new LeaseRepo(db);
    expect(leases.listActive('port')).toHaveLength(1);
  }, 20_000);
```

Add `import { LeaseRepo } from '../../src/db/repositories/lease.js';` to that file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/daemon/runtime.test.ts`
Expected: FAIL — `$CW_PORT_BASE` expands to empty, and two active port leases remain.

- [ ] **Step 3: Give `SessionRuntime.start` an env parameter**

In `src/daemon/runtime.ts`, change the signature and the spawn:

```ts
  start(session: SessionRow, adapter: AgentAdapter, env: Record<string, string> = {}): number {
```

and inside, replace the `env` passed to `adapter.spawn`:

```ts
    const proc = adapter.spawn({
      cwd: session.worktreePath,
      env: { ...env, CW_SESSION_ID: session.id, CW_SESSION_NAME: session.name },
      cols: 80,
      rows: 24,
    });
```

`CW_SESSION_ID` and `CW_SESSION_NAME` are set last deliberately: a lease must never be able to overwrite the session's own identity.

- [ ] **Step 3b: Forward the CLIENT's environment, not the daemon's**

Found by end-to-end testing of M0: the daemon inherits the environment of whichever `cw` invocation happened to start it, and **every agent it ever spawns gets that environment**. Activate a virtualenv or `nvm use 20` in a fresh shell, create a session, and the agent silently gets the toolchain from whenever the daemon first booted. For a tool whose whole job is running coding agents, handing them the wrong toolchain without saying so is worse than failing.

The env plumbing this task already introduces is the right place to fix it. Add an optional `env` param to the start methods in `src/daemon/methods.ts`:

```ts
function clientEnv(p: Record<string, unknown>): Record<string, string> {
  const raw = p.env;
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
```

and in `start`, layer it under the leases — a lease must win over the client's shell, or a session's port would depend on what the user happened to export:

```ts
    const env = { ...clientEnv(p), ...(await leaseManager.acquire(row.id)) };
```

In `src/cli/commands/session.ts` and `src/cli/commands/attach.ts`, every `session.start` / `session.resume` call passes `env: { ...process.env }`.

Add a test asserting an env var exported by the client reaches the agent:

```ts
  it('forwards the client environment to the agent', async () => {
    await client.call('session.new', { workspaceId, name: 'envtest', agent: 'claude', worktree: true });
    await client.call('session.start', {
      workspaceId, idOrName: 'envtest', env: { CW_E2E_MARKER: 'from-client' },
    });

    let seen = '';
    client.onNotification((m, p) => {
      if (m === 'session.data') seen += (p as { chunk: string }).chunk;
    });
    await client.call('session.attach', { workspaceId, idOrName: 'envtest' });
    await client.call('session.input', {
      workspaceId, idOrName: 'envtest', data: 'echo "M=$CW_E2E_MARKER"\n',
    });
    await waitFor(() => seen.includes('M=from-client'));
  }, 20_000);
```

- [ ] **Step 4: Wire the manager into `buildMethods`**

In `src/daemon/methods.ts`, extend the signature and body:

```ts
export function buildMethods(
  db: Database,
  projectRoot: string,
  adapterFactory?: AdapterFactory,
  config: CrossweaveConfig = loadConfig(projectRoot),
): Record<string, MethodHandler> {
  const workspaces = new WorkspaceManager(db);
  const sessions = new SessionManager(db, adapterFactory);
  const leaseManager = new LeaseManager(db, projectRoot, config);
  // Nothing a previous daemon held can have survived its death, and a lease left
  // marked active would permanently shrink the pool.
  leaseManager.releaseAll();

  const runtime = new SessionRuntime((sessionId) => {
    sessions.clearRunning(sessionId);
    leaseManager.release(sessionId);
  });
  sessions.onKill = (id) => runtime.stop(id);
```

Make `start` async so it can await the acquire:

```ts
  async function start(p: Record<string, unknown>): Promise<SessionRow> {
    const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
    assertResumable(row);
    const env = await leaseManager.acquire(row.id);
    const pid = runtime.start(row, sessions.adapterFor(row.agentKind), env);
    sessions.markStatus(row.id, 'running', pid);
    return sessions.resolve(row.workspaceId, row.id);
  }
```

`session.start` and `session.resume` must now `await start(p)`. `session.stop` releases after the runtime stop:

```ts
    'session.stop': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      await runtime.stop(row.id);
      leaseManager.release(row.id);
      return { ok: true };
    },
```

Import `LeaseManager`, `loadConfig` and `type CrossweaveConfig`.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`

The runtime's exit callback now releases leases too, so a session that exits on its own frees its block. Confirm the existing `resume after stop starts a genuinely new process` test still passes — acquiring on every start means a resumed session gets a *fresh* block, which is correct but worth seeing pass.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/runtime.ts src/daemon/methods.ts tests/daemon/runtime.test.ts
git commit -m "feat(leases): inject session leases into the agent environment"
```

---

### Task 10: Disk Guard

**Files:**
- Create: `src/isolation/disk-guard.ts`
- Test: `tests/isolation/disk-guard.test.ts`

**Interfaces:**
- Consumes: `SessionRepo`, `CrossweaveConfig`, `CrossweaveError`
- Produces:
  - `interface DiskUsage { sessionId: string; name: string; bytes: number }`
  - `measureWorktrees(db: Database, workspaceId: string): DiskUsage[]`
  - `assertDiskAvailable(db: Database, workspaceId: string, config: CrossweaveConfig): void`

- [ ] **Step 1: Write the failing test**

Create `tests/isolation/disk-guard.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { measureWorktrees, assertDiskAvailable } from '../../src/isolation/disk-guard.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { newId } from '../../src/core/ids.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let workspaceId: string;

async function addSessionWithBytes(name: string, bytes: number): Promise<string> {
  const id = newId('s');
  const path = join(fx.root, '.crossweave', 'worktrees', id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'blob'), Buffer.alloc(bytes));
  new SessionRepo(db).insert({
    id, workspaceId, name, agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: path, branch: `cw/${name}`,
    createdAt: '2026-08-10T00:00:00.000Z', lastActiveAt: '2026-08-10T00:00:00.000Z',
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  return id;
}

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: fx.root,
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('measureWorktrees', () => {
  it('reports a size per session', async () => {
    await addSessionWithBytes('a', 4096);
    await addSessionWithBytes('b', 8192);
    const usage = measureWorktrees(db, workspaceId);
    expect(usage).toHaveLength(2);
    expect(usage.find((u) => u.name === 'b')?.bytes).toBeGreaterThanOrEqual(8192);
  });

  it('reports zero for a session whose worktree is gone', async () => {
    const id = await addSessionWithBytes('c', 1024);
    await rm(join(fx.root, '.crossweave', 'worktrees', id), { recursive: true, force: true });
    expect(measureWorktrees(db, workspaceId).find((u) => u.name === 'c')?.bytes).toBe(0);
  });
});

describe('assertDiskAvailable', () => {
  it('passes under the limits', async () => {
    await addSessionWithBytes('small', 1024);
    expect(() => assertDiskAvailable(db, workspaceId, DEFAULT_CONFIG)).not.toThrow();
  });

  it('refuses when one session exceeds the per-session limit', async () => {
    await addSessionWithBytes('fat', 64 * 1024);
    const config = {
      ...DEFAULT_CONFIG,
      disk: { perSessionBytes: 8 * 1024, perWorkspaceBytes: 1024 * 1024 },
    };
    expect(() => assertDiskAvailable(db, workspaceId, config)).toThrowError(
      expect.objectContaining({ code: 'DISK_LIMIT_EXCEEDED' }) as unknown as Error,
    );
  });

  it('refuses when the workspace total exceeds its limit', async () => {
    await addSessionWithBytes('one', 32 * 1024);
    await addSessionWithBytes('two', 32 * 1024);
    const config = {
      ...DEFAULT_CONFIG,
      disk: { perSessionBytes: 1024 * 1024, perWorkspaceBytes: 40 * 1024 },
    };
    expect(() => assertDiskAvailable(db, workspaceId, config)).toThrowError(
      expect.objectContaining({ code: 'DISK_LIMIT_EXCEEDED' }) as unknown as Error,
    );
  });

  it('names the offender and points at gc', async () => {
    await addSessionWithBytes('hog', 64 * 1024);
    const config = {
      ...DEFAULT_CONFIG,
      disk: { perSessionBytes: 8 * 1024, perWorkspaceBytes: 1024 * 1024 },
    };
    try {
      assertDiskAvailable(db, workspaceId, config);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('hog');
      expect((err as Error).message).toContain('cw gc');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/isolation/disk-guard.test.ts`
Expected: FAIL — cannot resolve `../../src/isolation/disk-guard.js`.

- [ ] **Step 3: Implement `src/isolation/disk-guard.ts`**

```ts
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../core/errors.js';
import type { CrossweaveConfig } from '../core/config.js';
import { SessionRepo } from '../db/repositories/session.js';

export interface DiskUsage {
  sessionId: string;
  name: string;
  bytes: number;
}

/** Recursive size in bytes. Returns 0 for a path that is gone rather than throwing. */
function directorySize(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(child);
      else if (entry.isFile()) total += statSync(child).size;
      // Symlinks are counted as zero: following them would double-count, and a link
      // out of the worktree is not this worktree's disk.
    } catch {
      // A file that vanished mid-walk is not an error — an agent is writing here.
    }
  }
  return total;
}

export function measureWorktrees(db: Database, workspaceId: string): DiskUsage[] {
  return new SessionRepo(db)
    .listByWorkspace(workspaceId)
    .filter((s) => s.worktreePath !== null)
    .map((s) => ({
      sessionId: s.id,
      name: s.name,
      bytes: directorySize(s.worktreePath ?? ''),
    }));
}

function human(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)}${units[unit]}`;
}

/**
 * Refuse to start another session when the disk is already over budget.
 *
 * The failure this prevents is not subtle: a 2 GB checkout was measured consuming
 * 9.8 GB of worktrees in twenty minutes. Refusing early, naming the offender, and
 * pointing at `cw gc` is far kinder than a full disk.
 */
export function assertDiskAvailable(
  db: Database,
  workspaceId: string,
  config: CrossweaveConfig,
): void {
  const usage = measureWorktrees(db, workspaceId);

  const worst = usage.reduce<DiskUsage | undefined>(
    (max, u) => (max === undefined || u.bytes > max.bytes ? u : max),
    undefined,
  );
  if (worst !== undefined && worst.bytes > config.disk.perSessionBytes) {
    throw new CrossweaveError(
      'DISK_LIMIT_EXCEEDED',
      `Session ${worst.name} holds ${human(worst.bytes)}, over the ` +
        `${human(config.disk.perSessionBytes)} per-session limit. ` +
        'Run `cw gc` to reclaim ended sessions, or raise disk.perSessionBytes.',
    );
  }

  const total = usage.reduce((sum, u) => sum + u.bytes, 0);
  if (total > config.disk.perWorkspaceBytes) {
    throw new CrossweaveError(
      'DISK_LIMIT_EXCEEDED',
      `Worktrees hold ${human(total)} in total, over the ` +
        `${human(config.disk.perWorkspaceBytes)} workspace limit. ` +
        'Run `cw gc` to reclaim ended sessions, or raise disk.perWorkspaceBytes.',
    );
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/isolation/disk-guard.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/isolation/disk-guard.ts tests/isolation/disk-guard.test.ts
git commit -m "feat(disk): measure worktree usage and refuse over-budget sessions"
```

---

### Task 11: `cw gc`, and the guard on session creation

**Files:**
- Modify: `src/domain/session.ts` — check disk before creating
- Create: `src/domain/gc.ts`
- Modify: `src/daemon/methods.ts` — `workspace.gc`, and run it on boot
- Modify: `src/cli/commands/workspace.ts` — `cw gc`
- Test: `tests/domain/gc.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `SessionRepo`, `removeWorktree`, `deleteBranch`, `measureWorktrees`
- Produces:
  - `interface GcResult { removed: string[]; reclaimedBytes: number }`
  - `collectGarbage(db: Database, projectRoot: string, workspaceId: string): Promise<GcResult>`
  - RPC `workspace.gc`, CLI `cw gc`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/gc.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { collectGarbage } from '../../src/domain/gc.js';
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

describe('collectGarbage', () => {
  it('reclaims dead sessions and leaves live ones alone', async () => {
    const dead = await sessions.create({ workspaceId, name: 'dead', agent: 'claude', worktree: true });
    const live = await sessions.create({ workspaceId, name: 'live', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'dead', { removeWorktree: false });

    const result = await collectGarbage(db, fx.root, workspaceId);

    expect(result.removed).toEqual(['dead']);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(existsSync(dead.worktreePath ?? '')).toBe(false);
    expect(existsSync(live.worktreePath ?? '')).toBe(true);
    expect(sessions.list(workspaceId).map((s) => s.name)).toEqual(['live']);
  }, 30_000);

  it('is a no-op when nothing has ended', async () => {
    await sessions.create({ workspaceId, name: 'live', agent: 'claude', worktree: true });
    const result = await collectGarbage(db, fx.root, workspaceId);
    expect(result.removed).toEqual([]);
    expect(result.reclaimedBytes).toBe(0);
  }, 30_000);

  it('deletes the dead session\'s branch too, freeing the name', async () => {
    await sessions.create({ workspaceId, name: 'recycle', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'recycle', { removeWorktree: false });
    await collectGarbage(db, fx.root, workspaceId);

    const { simpleGit } = await import('simple-git');
    expect((await simpleGit(fx.root).branch()).all).not.toContain('cw/recycle');
    const revived = await sessions.create({ workspaceId, name: 'recycle', agent: 'claude', worktree: true });
    expect(revived.branch).toBe('cw/recycle');
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/domain/gc.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/gc.js`.

- [ ] **Step 3: Implement `src/domain/gc.ts`**

```ts
import type { Database } from 'bun:sqlite';
import { SessionRepo } from '../db/repositories/session.js';
import { WorkspaceRepo } from '../db/repositories/workspace.js';
import { CrossweaveError } from '../core/errors.js';
import { removeWorktree, deleteBranch } from '../isolation/worktree.js';
import { measureWorktrees } from '../isolation/disk-guard.js';

export interface GcResult {
  removed: string[];
  reclaimedBytes: number;
}

/**
 * Reclaim every session that has ended: its worktree, its branch and its row.
 *
 * Deliberately the same disposal `session rm` performs, so a name freed by gc behaves
 * exactly like a name freed by hand. Live sessions are never touched, and a failure
 * on one session does not abandon the rest — a half-finished gc that stops at the
 * first stubborn worktree is worse than one that reports what it could not take.
 */
export async function collectGarbage(
  db: Database,
  projectRoot: string,
  workspaceId: string,
): Promise<GcResult> {
  const workspace = new WorkspaceRepo(db).findById(workspaceId);
  if (!workspace) {
    throw new CrossweaveError('WORKSPACE_NOT_FOUND', `No such workspace: ${workspaceId}`);
  }

  const repo = new SessionRepo(db);
  const sizes = new Map(measureWorktrees(db, workspaceId).map((u) => [u.sessionId, u.bytes]));
  const ended = repo
    .listByWorkspace(workspaceId)
    .filter((s) => s.status === 'dead' || s.status === 'landed');

  const removed: string[] = [];
  let reclaimedBytes = 0;

  for (const session of ended) {
    const own =
      session.worktreePath !== null && session.worktreePath !== workspace.rootPath
        ? session.worktreePath
        : null;
    if (own !== null) await removeWorktree(workspace.rootPath, own).catch(() => undefined);
    if (session.branch !== null) {
      await deleteBranch(workspace.rootPath, session.branch).catch(() => undefined);
    }
    repo.delete(session.id);
    removed.push(session.name);
    reclaimedBytes += sizes.get(session.id) ?? 0;
  }

  // Worktrees git knows about that no session row claims. `cw workspace delete`
  // removes the workspace row and cascades away its sessions WITHOUT touching the
  // disk, so every worktree it leaves behind is invisible to the loop above — it
  // walks sessions, and those no longer exist. Found by end-to-end testing of M0:
  // two orphans and three branches survived a `workspace delete --force`.
  for (const path of await listWorktreePaths(workspace.rootPath)) {
    if (repo.findByWorktreePath(path) !== undefined) continue;
    await removeWorktree(workspace.rootPath, path).catch(() => undefined);
    removed.push(path.split('/').pop() ?? path);
  }

  return { removed, reclaimedBytes };
}
```

**Plan/source divergence, found by the final whole-branch review, DoD-breaking:** Step 5
below calls `collectGarbage` — the function above, which reclaims BOTH ended sessions AND
orphans — directly from the daemon's boot path. `cw session kill` (without `--rm-worktree`)
deliberately leaves a session `dead` with its worktree and branch intact (Task 1's whole
model: "the name stays taken exactly as long as the work does", and M4's `cw land` needs the
kept branch). Calling `collectGarbage` at boot means **every daemon restart silently deletes
every killed-but-not-removed session's worktree and branch** — reproduced end to end: kill a
session without `--rm-worktree`, restart the daemon, the branch is gone. This wording here
("Reclaim anything a previous daemon left behind") meant orphaned worktrees, not a user's
still-referenced work — the plan's Step 5 intent and this function's actual scope diverged.

The fix: split this function's two behaviors so the boot path only gets the orphan-safe half.
`collectGarbage` (above) is unchanged and still does both, in this order, sharing one
`disposedPaths` set so a worktree is never reported twice — it remains what `workspace.gc` /
`cw gc` calls, the explicit, user-requested full sweep. A new `collectOrphans` exposes only
the orphan sweep (the second loop above, lines checking `findByWorktreePath`), and Step 5's
boot-time call below must use `collectOrphans`, not `collectGarbage`.

```ts
export async function collectOrphans(db: Database, workspaceId: string): Promise<GcResult> {
  return sweepOrphans(db, workspaceId, new Set());
}

export async function collectGarbage(db: Database, workspaceId: string): Promise<GcResult> {
  const disposedPaths = new Set<string>();
  const ended = await reclaimEnded(db, workspaceId, disposedPaths);
  const orphaned = await sweepOrphans(db, workspaceId, disposedPaths);
  return {
    removed: [...ended.removed, ...orphaned.removed],
    reclaimedBytes: ended.reclaimedBytes + orphaned.reclaimedBytes,
  };
}
```

(`reclaimEnded` is the first loop above — dead/landed sessions only, never touching a live
or merely-`dead`-with-work-intact session's worktree/branch/row unless it is genuinely ended
AND explicitly requested via the full sweep. `sweepOrphans` is the second loop — worktrees no
session row claims. Both are private; `disposedPaths` prevents a worktree whose
`removeWorktree` failed in the ended-loop from being double-reported by the orphan-loop in
the same call. See the shipped `src/domain/gc.ts` for the exact split.)

`SessionRepo` needs one more lookup for that. Append to the class in `src/db/repositories/session.ts`:

```ts
  findByWorktreePath(path: string): SessionRow | undefined {
    const r = this.db
      .prepare(`SELECT ${COLUMNS} FROM session WHERE worktree_path = ?`)
      .get(path) as SessionRecord | null;
    return r ? toRow(r) : undefined;
  }
```

Import `listWorktreePaths` in `src/domain/gc.ts`. Task 4 must therefore keep it — it now has a `src/` caller.

Add a test for the orphan path:

```ts
  it('reclaims worktrees no session row claims', async () => {
    await sessions.create({ workspaceId, name: 'orphan', agent: 'claude', worktree: true });
    // Simulate what `workspace delete --force` leaves: the row is gone, the disk is not.
    const row = sessions.resolve(workspaceId, 'orphan');
    new SessionRepo(db).delete(row.id);
    expect(existsSync(row.worktreePath ?? '')).toBe(true);

    const result = await collectGarbage(db, fx.root, workspaceId);
    expect(result.removed).toHaveLength(1);
    expect(existsSync(row.worktreePath ?? '')).toBe(false);
  }, 30_000);
```

- [ ] **Step 4: Guard session creation on disk**

In `src/domain/session.ts`, `create` must refuse when the workspace is already over budget. Add a config field to the constructor:

```ts
  constructor(
    db: Database,
    private readonly adapterFactory: AdapterFactory = defaultCreateAdapter,
    private readonly config: CrossweaveConfig = DEFAULT_CONFIG,
  ) {
```

and at the top of `create`, after `assertValidSessionName`:

```ts
    // Checked before the worktree is created, not after: the whole point is to refuse
    // before adding another full checkout to a disk that is already over budget.
    assertDiskAvailable(this.db, opts.workspaceId, this.config);
```

That needs the `Database` kept on the instance — add `private readonly db: Database` via the constructor parameter property.

Import `assertDiskAvailable`, `type CrossweaveConfig` and `DEFAULT_CONFIG`.

- [ ] **Step 5: Add the RPC method and boot-time gc**

In `src/daemon/methods.ts`:

```ts
    'workspace.gc': async (p) => collectGarbage(db, projectRoot, str(p, 'id')),
```

and, beside `leaseManager.releaseAll()`:

```ts
  // Reclaim anything a previous daemon left behind. Best effort: a daemon that
  // cannot gc must still start, or a stuck worktree would make crossweave unusable.
  for (const ws of workspaces.list()) {
    void collectGarbage(db, projectRoot, ws.id).catch(() => undefined);
  }
```

**Plan/source divergence — see the note above `collectGarbage`'s definition.** This must
call `collectOrphans(db, ws.id)`, not `collectGarbage(db, projectRoot, ws.id)` — the boot
path may only sweep orphans, never a dead/landed session's still-referenced worktree and
branch. `collectGarbage`/`collectOrphans` also dropped the unused `projectRoot` parameter in
the shipped version (both take `workspaceId` and read `workspace.rootPath` internally):

```ts
  for (const ws of workspaces.list()) {
    void collectOrphans(db, ws.id).catch(() => undefined);
  }
```

Pass `config` into `new SessionManager(db, adapterFactory, config)`.

- [ ] **Step 6: Add the CLI command**

In `src/cli/commands/workspace.ts`, export a new top-level command:

```ts
export const gcCommand = defineCommand({
  meta: { name: 'gc', description: 'Reclaim worktrees and branches from ended sessions' },
  async run() {
    try {
      await withClient(async (client) => {
        const ws = await client.call<Workspace>('workspace.init', {});
        const result = await client.call<{ removed: string[]; reclaimedBytes: number }>(
          'workspace.gc', { id: ws.id },
        );
        if (result.removed.length === 0) {
          process.stdout.write('nothing to reclaim\n');
          return;
        }
        process.stdout.write(
          `reclaimed ${result.removed.length} session(s): ${result.removed.join(', ')}\n`,
        );
      });
    } catch (err) { fail(err); }
  },
});
```

Register it in `src/cli/index.ts`'s `subCommands` as `gc: gcCommand`.

- [ ] **Step 7: Add the CLI test**

Append to `tests/cli/cli.test.ts`:

```ts
  it('gc reclaims ended sessions and reports nothing when there are none', async () => {
    await cw(['init']);
    expect((await cw(['gc'])).stdout).toContain('nothing to reclaim');

    await cw(['session', 'new', '--name', 'trash', '--agent', 'claude']);
    await cw(['session', 'kill', 'trash', '--yes']);

    const r = await cw(['gc']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('trash');
    expect((await cw(['session', 'list'])).stdout).toContain('no sessions');
  }, 60_000);
```

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`

- [ ] **Step 9: Commit**

```bash
git add src/domain/gc.ts src/domain/session.ts src/daemon/methods.ts src/cli/commands/workspace.ts src/cli/index.ts tests/domain/gc.test.ts tests/cli/cli.test.ts
git commit -m "feat(gc): reclaim ended sessions and guard creation on disk budget"
```

---

## M1 Definition of Done

- `bun test && bun run typecheck && bun run build` is green, and the process exits on its own.
- **Two sessions started at once get different `CW_PORT_BASE` values, different `COMPOSE_PROJECT_NAME`s and different `XDG_CACHE_HOME`s** — verified by echoing them from inside each agent, not by reading the lease table.
- A port held by an unrelated process on the machine is never handed to a session.
- Stopping or killing a session frees its leases; the next session reuses the block.
- A daemon restart releases every lease the previous one held.
- `cw gc` removes ended sessions' worktrees, branches and rows, and reports what it reclaimed.
- `cw session new` refuses with `DISK_LIMIT_EXCEEDED` when the workspace is over budget, naming the offending session and pointing at `cw gc`.
- A killed session's name is reusable after `--rm-worktree`, after `cw session rm`, or after `cw gc`.
- `crossweave.config.json` is honoured, and a malformed one fails with `CONFIG_INVALID` rather than silently falling back.
- Every new error path exits non-zero with exactly one `CODE: message` line: `CONFIG_INVALID`, `NO_PORTS_AVAILABLE`, `DISK_LIMIT_EXCEEDED`, `SESSION_STILL_LIVE`, `DAEMON_STOP_TIMEOUT`, `INVALID_ARGUMENTS`.
- Every guard added in Task 2 fails when its fix is reverted — verified per test, not in aggregate.
- `bun test` leaves no `cw-template-*` or `cw-git-*` directory behind and no stray daemon.

## Deferred to M2 and beyond (explicitly not in M1)

Reconciliation on daemon start (M2 — the event ledger is what makes it possible to know what a dead daemon was doing; M1 only releases leases wholesale), the message bus and context store (M2), `cw blame` (M2), Collision Radar (M3), the Convergence Engine and `cw land` (M4), ACP and enforced Safe Mode (M5), the TUI (M6).

Also deliberately out of scope: the `branch` db strategy (Neon/Supabase), which needs network credentials and a provider abstraction; shared build-cache mode, which trades isolation for disk and should wait until someone asks; and per-session port allocation finer than a whole block.
