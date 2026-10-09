# Session checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Snapshot a session's worktree at the end of every agent turn (and on demand) as hidden git commits, so the person can diff one turn and put the files back.

**Architecture:** A new git-only module `src/domain/checkpoint.ts` writes orphan commits under `refs/crossweave/checkpoints/<sessionId>/<seq>` from a private index (never the real index, branch or working tree). The daemon queues one when `ActivityTracker.sweep` sees `working → idle|asked` (and a `baseline` on the first `→ working`), and exposes `checkpoint.list|take|diff|restore`. `cw checkpoint` and a cockpit "Checkpoints…" dialog are thin clients.

**Tech Stack:** Bun ≥ 1.3.13, TypeScript (strict), git CLI via `execFile`, Preact (cockpit), `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-10-session-checkpoints-design.md`

## Global Constraints

- Zero native modules; no new dependency (`AGENTS.md`).
- `SCHEMA_VERSION` stays **18**; no migration, no new table.
- Errors are `CrossweaveError` with a string code; user-facing copy in English; the CLI prints exactly one parseable `CODE: message` line (`fail()` in `src/cli/context.ts`).
- Comments explain WHY only (a race closed, an alternative rejected).
- Git is run with `execFile` and an argument list, never a shell string.
- Tests pin behaviour and the RPC/CLI contract, never log strings; never weaken a test to make it pass.
- macOS and Linux only; the cockpit is macOS arm64.
- Run gates one at a time with `bun test --max-concurrency=1` (`AGENTS.md` resource budget). `rm -rf` is blocked by a hook here; the tests' fixture cleanup already handles temp dirs.
- Work stays on branch `feat/checkpoints`; **nothing is committed until the owner says so** (global §6, memory: never commit to `main` unasked). Each task ends with a "stage and propose" step, not a commit.
- Citty ignores unknown flags, so every CLI arg is declared.

## Review Focus

Failure modes the spec implies that no happy-path test covers; each has a test in the owning task.

1. **Awkward file names** (spaces, accents, a leading dash) must survive take, diff and restore — `-z` output everywhere (Task 2, Task 3).
2. **A pristine worktree** (tree identical to HEAD) still gets its first checkpoint so the first turn can be undone (Task 2).
3. **The worktree vanished** while a checkpoint was queued: the daemon logs and carries on, the sweep never throws (Task 5).
4. **Binary files** in a diff count as 0/0 lines and never break the parser (Task 3).
5. **The restore target is pruned by its own pre-restore checkpoint** (retention reached) and the restore still completes (Task 3).

## Amendments from the adversarial review (2026-10-10) — these supersede the task code below

An independent Opus review ran the plan's git commands and tests in a scratch repo (verdict GO-WITH-FIXES). Where a task's
code below disagrees with this list, **this list wins**; the spec carries the same changes.

1. **Restore (Task 3) is rewritten.** The plan's `assertContained`-based delete removed a symlink's *target* and failed on
   a link pointing outside; `checkout-index -f` also destroyed ignored files that stood where the checkpoint needed a
   different type. New rule: validate lexically before touching anything (each leading directory of every path to write or
   delete is absent, a real directory, or about to be deleted — never a symlink, never an ignored file; a directory where
   a file belongs may go only if empty), else `CHECKPOINT_RESTORE_BLOCKED`; unlink deletes lexically; run `read-tree` +
   `checkout-index` through a throwaway index so the private index keeps its stat cache. New regression tests A (internal
   symlink), B (ignored files in a directory), C (link to outside), F (ignored file where a directory belongs); the symlink
   test now requires a successful restore.
2. **No `baseline`.** Kinds are `start | turn | manual | pre-restore`. `→ working` takes `start`, `working → idle|asked`
   takes `turn`, **only while a recognised agent runs in the session** (a plain shell reaches `working` on any output).
   Retention 50. `autoCheckpoint` no longer lists checkpoints.
3. **Counts live in the subject** (`files=a,m,d`), so `listCheckpoints` is one `for-each-ref` and no longer depends on
   `head^{tree}` or spawns N `diff-tree` processes.
4. **`diffBetween` reads `--numstat -z` / `--name-status -z`** (Task 1), so awkward names are not C-quoted.
5. **Size guard** applies to automatic checkpoints only (a restore must not be impossible exactly when an agent misbehaved)
   and names the three largest files.
6. **`pruneOrphans`** only touches ids whose index file exists in this project's `.crossweave/checkpoint-index`.
7. **Daemon trigger is testable:** `createAutoCheckpointer` (a factory with injected `findSession`, `contextFor`,
   `agentOf`, `log`) and `assertNotBusy` live in `src/daemon/checkpoint-trigger.ts`, with tests for: takes only with an
   agent, silent on no worktree, survives a vanished worktree, refuses a busy restore unless forced.
8. **Cockpit:** `/** @jsxImportSource preact */` on `CheckpointsDialog.tsx`; the row renders `#seq` and the counts as single
   strings; `ProjectView` guards `sessionById(...) !== null` (it returns `null`, not `undefined`).
9. Not adopted, recorded as limitations: re-validating the previewed plan at apply time; batching ref deletes with
   `update-ref --stdin`; making `diffBetween` asynchronous.

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/session-diff.ts` (modify) | Extract `diffBetween(cwd, a, b, opts)`; `sessionDiff` calls it |
| `src/domain/checkpoint.ts` (create) | All checkpoint git logic; no daemon knowledge |
| `src/daemon/checkpoint-trigger.ts` (create) | Pure `checkpointKindFor(from, to)` |
| `src/daemon/session-status.ts` (modify) | `ActivityTracker.onChange` listener |
| `src/daemon/methods.ts` (modify) | Four RPCs + the automatic trigger |
| `src/domain/session.ts`, `src/domain/gc.ts`, `src/convergence/land.ts` (modify) | Delete a session's checkpoints where its worktree goes |
| `src/cli/commands/checkpoint.ts` (create), `src/cli/index.ts` (modify) | `cw checkpoint list|take|diff|restore` |
| `apps/cockpit/electron/channels.ts`, `src/host/cockpit-api.ts` (modify) | Allow and expose the RPCs |
| `apps/cockpit/src/lib/checkpoints.ts` (create) | Types, `parseCheckpoints`, `describeRestore` |
| `apps/cockpit/src/ui/CheckpointsDialog.tsx` (create) | The dialog (`CheckpointList` is pure and walk-tested) |
| `apps/cockpit/src/ui/Sidebar.tsx`, `ProjectView.tsx`, `app.css` (modify) | Menu entry, wiring, a few rules |
| `docs/superpowers/specs/2026-10-10-session-checkpoints-known-limitations.md` (create) + digest line | Debt record with measurements |

---

### Task 1: Extract `diffBetween` from `sessionDiff`

**Files:**
- Modify: `src/domain/session-diff.ts`
- Test: `tests/domain/session-diff.test.ts`

**Interfaces:**
- Produces: `export type TreeDiff = Omit<SessionDiff, 'uncommitted'>` and `export function diffBetween(cwd: string, a: string, b: string, opts?: { maxPatchBytes?: number; patch?: boolean }): TreeDiff`. `a` and `b` are any tree-ish git accepts. `sessionDiff`'s behaviour is unchanged.

- [ ] **Step 1: Write the failing tests** — append to `tests/domain/session-diff.test.ts` (add `diffBetween` to the import from `../../src/domain/session-diff.js`):

```ts
describe('diffBetween', () => {
  const treeOf = async (ref: string): Promise<string> =>
    (await $`git rev-parse ${`${ref}^{tree}`}`.cwd(fx.root).quiet().text()).trim();

  it('diffs two trees with the same shape and counts sessionDiff produces', async () => {
    const a = await treeOf('HEAD');
    await commitFile(fx.root, 'new.txt', 'a\nb\n', 'add new');
    const b = await treeOf('HEAD');
    const diff = diffBetween(fx.root, a, b);
    expect(diff.files).toEqual([{ path: 'new.txt', status: 'added', added: 2, deleted: 0 }]);
    expect(diff.patch).toContain('+a');
    expect(diff.truncated).toBe(false);
  });

  it('cuts the patch at maxPatchBytes on a line boundary and says so', async () => {
    const a = await treeOf('HEAD');
    await commitFile(fx.root, 'big.txt', Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n', 'big');
    const b = await treeOf('HEAD');
    const diff = diffBetween(fx.root, a, b, { maxPatchBytes: 200 });
    expect(diff.truncated).toBe(true);
    expect(diff.patch.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(diff.patch)).toBeLessThanOrEqual(200);
  });

  it('skips the patch when asked', async () => {
    const a = await treeOf('HEAD');
    await commitFile(fx.root, 'x.txt', 'x\n', 'x');
    const diff = diffBetween(fx.root, a, await treeOf('HEAD'), { patch: false });
    expect(diff.patch).toBe('');
    expect(diff.files).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/domain/session-diff.test.ts --max-concurrency=1`
Expected: FAIL — `diffBetween` is not exported.

- [ ] **Step 3: Implement** — replace everything from `const range = ...` to the end of the patch block in `src/domain/session-diff.ts` so the file's bottom half reads exactly:

```ts
export type TreeDiff = Omit<SessionDiff, 'uncommitted'>;

/**
 * `git diff a b` for any two tree-ish values, parsed. Shared by `sessionDiff` (a commit range) and
 * checkpoints (two snapshot trees), so the numstat/name-status/truncation code exists once.
 */
export function diffBetween(
  cwd: string,
  a: string,
  b: string,
  opts: { maxPatchBytes?: number; patch?: boolean } = {},
): TreeDiff {
  // --no-renames: a rename reads as delete + add, one path per line, nothing to parse.
  const counts = new Map<string, { added: number; deleted: number }>();
  for (const line of git(cwd, ['diff', '--no-renames', '--numstat', a, b]).split('\n')) {
    const [added, deleted, ...rest] = line.split('\t');
    if (rest.length === 0) continue;
    counts.set(rest.join('\t'), { added: Number(added) || 0, deleted: Number(deleted) || 0 });
  }
  const files: FileChange[] = [];
  for (const line of git(cwd, ['diff', '--no-renames', '--name-status', a, b]).split('\n')) {
    const [code, ...rest] = line.split('\t');
    if (code === undefined || rest.length === 0) continue;
    const path = rest.join('\t');
    const c = counts.get(path) ?? { added: 0, deleted: 0 };
    files.push({ path, status: STATUS[code[0] ?? 'M'] ?? 'modified', ...c });
  }
  files.sort((x, y) => x.path.localeCompare(y.path));

  let patch = '';
  let truncated = false;
  if (opts.patch !== false) {
    const max = opts.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
    const full = git(cwd, ['diff', '--no-renames', '--no-color', a, b]);
    const buf = Buffer.from(full);
    truncated = buf.length > max;
    // Cut on a line boundary so the last line shown is a whole line.
    patch = full;
    if (truncated) {
      const cut = buf.subarray(0, max).toString('utf8');
      patch = cut.slice(0, cut.lastIndexOf('\n') + 1);
    }
  }
  return { files, patch, truncated };
}
```

and in `sessionDiff`, after the `try { from = ... } catch {...}` block, replace the old body so it ends:

```ts
  const { files, patch, truncated } = diffBetween(projectRoot, from, ref, opts);

  let uncommitted = 0;
  if (worktreePath !== null && existsSync(worktreePath)) {
    try {
      uncommitted = git(worktreePath, ['status', '--porcelain']).split('\n').filter((l) => l !== '').length;
    } catch {
      uncommitted = 0;
    }
  }
  return { files, patch, truncated, uncommitted };
}
```

(`git diff A B` and `git diff A..B` are the same diff, so `sessionDiff`'s output is unchanged; the existing tests prove it.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/domain/session-diff.test.ts --max-concurrency=1` then `bun run typecheck`
Expected: PASS (old and new tests), 0 type errors.

- [ ] **Step 5: Stage and propose** — `git add src/domain/session-diff.ts tests/domain/session-diff.test.ts`; proposed message `refactor: extract diffBetween from sessionDiff so checkpoints reuse the diff parser`. Do not commit until the owner says so.

---

### Task 2: Checkpoint module — take and list

**Files:**
- Create: `src/domain/checkpoint.ts`
- Create: `tests/domain/checkpoint.test.ts`

**Interfaces:**
- Consumes: `diffBetween`, `TreeDiff` (Task 1); `assertContained`, `crossweaveDir` (`src/core/paths.js`); `redactSecrets`; `CrossweaveError`.
- Produces (exact):
  - `type CheckpointKind = 'baseline' | 'turn' | 'manual' | 'pre-restore'`
  - `interface CheckpointFiles { added: number; modified: number; deleted: number }`
  - `interface CheckpointInfo { seq: number; kind: CheckpointKind; label?: string; at: number; head: string; tree: string; files: CheckpointFiles }`
  - `interface CheckpointContext { projectRoot: string; sessionId: string; worktree: string; now?: () => number; keep?: number; maxUntrackedBytes?: number }`
  - `takeCheckpoint(ctx, kind: Exclude<CheckpointKind, 'pre-restore'>, label?: string): Promise<{ created: boolean; info: CheckpointInfo }>`
  - `listCheckpoints(ctx): Promise<CheckpointInfo[]>` (newest first)
  - constants `CHECKPOINT_KEEP = 20`, `CHECKPOINT_MAX_UNTRACKED_BYTES = 50 * 1024 * 1024`
  - Later tasks add `diffCheckpoints`, `restoreCheckpoint`, `deleteSessionCheckpoints`, `pruneOrphans` to this file.

- [ ] **Step 1: Write the failing tests** — create `tests/domain/checkpoint.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { listCheckpoints, takeCheckpoint, type CheckpointContext } from '../../src/domain/checkpoint.js';
import { commitFile, makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let wt: string;
let ctx: CheckpointContext;
beforeEach(async () => {
  fx = await makeGitFixture();
  await commitFile(fx.root, 'a.txt', 'one\n', 'seed a');
  await commitFile(fx.root, 'b.txt', 'bee\n', 'seed b');
  // Inside the fixture, so its cleanup removes the worktree too.
  wt = join(fx.root, '.wt');
  await $`git worktree add -q -b cw/t ${wt}`.cwd(fx.root).quiet();
  let t = 1_000;
  ctx = { projectRoot: fx.root, sessionId: 's_test', worktree: wt, now: () => (t += 1_000) };
});
afterEach(async () => { await fx.cleanup(); });

describe('takeCheckpoint', () => {
  it('captures modified and brand-new files; the first checkpoint is measured against HEAD', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    writeFileSync(join(wt, 'new.txt'), 'n\n');
    const { created, info } = await takeCheckpoint(ctx, 'baseline');
    expect(created).toBe(true);
    expect(info.seq).toBe(1);
    expect(info.kind).toBe('baseline');
    expect(info.files).toEqual({ added: 1, modified: 1, deleted: 0 });
    expect((await listCheckpoints(ctx)).map((c) => c.seq)).toEqual([1]);
  });

  it('a pristine worktree still gets its first checkpoint, so the first turn has a "before"', async () => {
    const { created, info } = await takeCheckpoint(ctx, 'baseline');
    expect(created).toBe(true);
    expect(info.files).toEqual({ added: 0, modified: 0, deleted: 0 });
  });

  it('records nothing when the tree equals the newest checkpoint', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    const first = await takeCheckpoint(ctx, 'turn');
    const again = await takeCheckpoint(ctx, 'turn');
    expect(again.created).toBe(false);
    expect(again.info.seq).toBe(first.info.seq);
    expect(await listCheckpoints(ctx)).toHaveLength(1);
  });

  it('numbers checkpoints and measures each against the one before it', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    await takeCheckpoint(ctx, 'baseline');
    writeFileSync(join(wt, 'b.txt'), 'bee2\n');
    writeFileSync(join(wt, 'c.txt'), 'c\n');
    const second = await takeCheckpoint(ctx, 'turn');
    expect(second.info.seq).toBe(2);
    expect(second.info.files).toEqual({ added: 1, modified: 1, deleted: 0 });
    expect((await listCheckpoints(ctx)).map((c) => c.seq)).toEqual([2, 1]);
  });

  it('keeps only the newest `keep` checkpoints', async () => {
    const small = { ...ctx, keep: 3 };
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(wt, 'a.txt'), `v${i}\n`);
      await takeCheckpoint(small, 'turn');
    }
    expect((await listCheckpoints(small)).map((c) => c.seq)).toEqual([5, 4, 3]);
  });

  it('does not capture files git ignores', async () => {
    await commitFile(wt, '.gitignore', 'ignored.log\n', 'ignore');
    writeFileSync(join(wt, 'ignored.log'), 'secret\n');
    writeFileSync(join(wt, 'kept.txt'), 'k\n');
    const { info } = await takeCheckpoint(ctx, 'baseline');
    const names = await $`git ls-tree -r --name-only ${info.tree}`.cwd(wt).quiet().text();
    expect(names).toContain('kept.txt');
    expect(names).not.toContain('ignored.log');
  });

  it('refuses a huge untracked payload and writes no ref', async () => {
    writeFileSync(join(wt, 'huge.bin'), Buffer.alloc(64));
    await expect(takeCheckpoint({ ...ctx, maxUntrackedBytes: 10 }, 'turn')).rejects.toMatchObject({ code: 'CHECKPOINT_TOO_LARGE' });
    expect(await listCheckpoints(ctx)).toHaveLength(0);
  });

  it('survives awkward file names', async () => {
    writeFileSync(join(wt, 'weird name é.txt'), 'w\n');
    writeFileSync(join(wt, '-dash.txt'), 'd\n');
    const { info } = await takeCheckpoint(ctx, 'baseline');
    expect(info.files.added).toBe(2);
  });

  it('serialises concurrent takes: one records, the other sees the same tree', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    const [x, y] = await Promise.all([takeCheckpoint(ctx, 'turn'), takeCheckpoint(ctx, 'turn')]);
    expect([x.created, y.created].filter(Boolean)).toHaveLength(1);
    expect(await listCheckpoints(ctx)).toHaveLength(1);
  });

  it('stores a label with control characters flattened', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    const { info } = await takeCheckpoint(ctx, 'manual', 'before\nrefactor');
    expect(info.label).toBe('before refactor');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/domain/checkpoint.test.ts --max-concurrency=1`
Expected: FAIL — module `src/domain/checkpoint.js` not found.

- [ ] **Step 3: Implement** — create `src/domain/checkpoint.ts`:

```ts
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CrossweaveError } from '../core/errors.js';
import { crossweaveDir } from '../core/paths.js';
import { redactSecrets } from '../core/redact-secrets.js';

const run = promisify(execFile);

export const CHECKPOINT_KEEP = 20;
export const CHECKPOINT_MAX_UNTRACKED_BYTES = 50 * 1024 * 1024;
const REF_ROOT = 'refs/crossweave/checkpoints';
// A fixed identity so a checkpoint never depends on (or fails for lack of) the person's git config.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'crossweave',
  GIT_AUTHOR_EMAIL: 'crossweave@localhost',
  GIT_COMMITTER_NAME: 'crossweave',
  GIT_COMMITTER_EMAIL: 'crossweave@localhost',
};

export type CheckpointKind = 'baseline' | 'turn' | 'manual' | 'pre-restore';
export interface CheckpointFiles { added: number; modified: number; deleted: number }
export interface CheckpointInfo {
  seq: number;
  kind: CheckpointKind;
  label?: string;
  /** Epoch ms. */
  at: number;
  /** HEAD when it was taken. */
  head: string;
  tree: string;
  /** Against the previous checkpoint; for the oldest, against its own HEAD. */
  files: CheckpointFiles;
}
export interface CheckpointContext {
  projectRoot: string;
  sessionId: string;
  worktree: string;
  now?: () => number;
  /** Retention; defaults to `CHECKPOINT_KEEP`. */
  keep?: number;
  maxUntrackedBytes?: number;
}

interface Raw { seq: number; ref: string; tree: string; kind: CheckpointKind; label?: string; at: number; head: string }

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (cause) {
    const e = cause as { stderr?: string; message?: string };
    throw new CrossweaveError('CHECKPOINT_GIT_FAILED', redactSecrets(`git ${args[0] ?? ''} failed: ${(e.stderr ?? e.message ?? '').trim()}`));
  }
}

/**
 * One chain per session: take, restore and prune never interleave. (The private index also keeps
 * a take from fighting the agent for the real `index.lock`.)
 */
const tails = new Map<string, Promise<unknown>>();
function locked<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const next = (tails.get(sessionId) ?? Promise.resolve()).then(fn);
  const tail = next.then(() => undefined, () => undefined);
  tails.set(sessionId, tail);
  void tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId); });
  return next;
}

function refPrefix(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new CrossweaveError('INVALID_ARGUMENTS', `Not a session id: ${sessionId}`);
  return `${REF_ROOT}/${sessionId}/`;
}

function indexPath(projectRoot: string, sessionId: string): string {
  return join(crossweaveDir(projectRoot), 'checkpoint-index', sessionId);
}

/**
 * The session's own index file. Seeded once from HEAD and then kept: it carries git's stat cache, so after the
 * first run `git add -A` only re-hashes what changed.
 */
async function privateIndex(ctx: CheckpointContext): Promise<string> {
  const path = indexPath(ctx.projectRoot, ctx.sessionId);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    await git(ctx.worktree, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: path });
  }
  return path;
}

/** An agent that writes a multi-GB file the repo does not ignore must not fill the disk through us. */
async function guardSize(ctx: CheckpointContext): Promise<void> {
  const limit = ctx.maxUntrackedBytes ?? CHECKPOINT_MAX_UNTRACKED_BYTES;
  const out = await git(ctx.worktree, ['ls-files', '-o', '--exclude-standard', '-z']);
  let total = 0;
  for (const rel of out.split('\0')) {
    if (rel === '') continue;
    try { total += lstatSync(join(ctx.worktree, rel)).size; } catch { /* vanished while we looked */ }
    if (total > limit) {
      throw new CrossweaveError('CHECKPOINT_TOO_LARGE', `Untracked files in the worktree exceed ${Math.round(limit / 1048576)} MB, so no checkpoint was taken. Ignore or remove the large files.`);
    }
  }
}

/** The worktree's content (tracked + untracked, minus ignored) as a tree object. Writes no ref. */
async function liveTree(ctx: CheckpointContext): Promise<string> {
  const index = await privateIndex(ctx);
  await guardSize(ctx);
  await git(ctx.worktree, ['add', '-A'], { GIT_INDEX_FILE: index });
  return (await git(ctx.worktree, ['write-tree'], { GIT_INDEX_FILE: index })).trim();
}

const SUBJECT = /^checkpoint (baseline|turn|manual|pre-restore) head=([0-9a-f]+) at=(\d+)(?: label=(.*))?$/;

async function listRaw(cwd: string, sessionId: string): Promise<Raw[]> {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname)%09%(tree)%09%(contents:subject)', refPrefix(sessionId)]);
  const rows: Raw[] = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const [ref, tree, ...rest] = line.split('\t');
    const m = SUBJECT.exec(rest.join('\t'));
    const seq = Number((ref ?? '').slice((ref ?? '').lastIndexOf('/') + 1));
    if (ref === undefined || tree === undefined || m === null || !Number.isInteger(seq)) continue;
    rows.push({ seq, ref, tree, kind: m[1] as CheckpointKind, head: m[2] ?? '', at: Number(m[3]), ...(m[4] ? { label: m[4] } : {}) });
  }
  return rows.sort((a, b) => b.seq - a.seq);
}

export interface TreeChange { status: 'A' | 'M' | 'D'; path: string }

/** `-z` throughout: a path with a space, accent, quote or newline is one record, never a parsing accident. */
export async function changesBetween(cwd: string, a: string, b: string): Promise<TreeChange[]> {
  const out = await git(cwd, ['diff-tree', '-r', '--no-renames', '--name-status', '-z', a, b]);
  const parts = out.split('\0');
  const rows: TreeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]?.[0];
    rows.push({ status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', path: parts[i + 1] ?? '' });
  }
  return rows;
}

function countFiles(changes: TreeChange[]): CheckpointFiles {
  return {
    added: changes.filter((c) => c.status === 'A').length,
    modified: changes.filter((c) => c.status === 'M').length,
    deleted: changes.filter((c) => c.status === 'D').length,
  };
}

async function describe(ctx: CheckpointContext, rows: Raw[], i: number): Promise<CheckpointInfo> {
  const row = rows[i]!;
  const before = rows[i + 1]?.tree ?? `${row.head}^{tree}`;
  return {
    seq: row.seq, kind: row.kind, ...(row.label !== undefined ? { label: row.label } : {}),
    at: row.at, head: row.head, tree: row.tree,
    files: countFiles(await changesBetween(ctx.worktree, before, row.tree)),
  };
}

const pad = (seq: number): string => String(seq).padStart(6, '0');
const cleanLabel = (label: string): string => label.replace(/\p{C}+/gu, ' ').trim().slice(0, 100);

/** Unlocked: `restoreCheckpoint` already holds the session's lock when it needs a pre-restore one. */
export async function snapshot(
  ctx: CheckpointContext, kind: CheckpointKind, label?: string,
): Promise<{ created: boolean; info: CheckpointInfo }> {
  const tree = await liveTree(ctx);
  const existing = await listRaw(ctx.worktree, ctx.sessionId);
  const newest = existing[0];
  if (newest !== undefined && newest.tree === tree) return { created: false, info: await describe(ctx, existing, 0) };

  const head = (await git(ctx.worktree, ['rev-parse', 'HEAD'])).trim();
  const at = (ctx.now ?? Date.now)();
  const clean = label === undefined ? '' : cleanLabel(label);
  const subject = `checkpoint ${kind} head=${head} at=${at}${clean === '' ? '' : ` label=${clean}`}`;
  // No parent, on purpose: a parent chain would keep every pruned checkpoint reachable through the newest one,
  // and pruning would free nothing. A turn's diff is tree against tree and needs no ancestry.
  const commit = (await git(ctx.worktree, ['commit-tree', tree, '-m', subject], IDENTITY)).trim();
  const seq = (newest?.seq ?? 0) + 1;
  const ref = `${refPrefix(ctx.sessionId)}${pad(seq)}`;
  // The empty old value makes git refuse if the ref already exists — two writers can never share a number.
  await git(ctx.worktree, ['update-ref', ref, commit, '']);
  const keep = ctx.keep ?? CHECKPOINT_KEEP;
  for (const old of existing.slice(keep - 1)) await git(ctx.worktree, ['update-ref', '-d', old.ref]);

  const fresh: Raw = { seq, ref, tree, kind, ...(clean === '' ? {} : { label: clean }), at, head };
  return { created: true, info: await describe(ctx, [fresh, ...existing], 0) };
}

export function takeCheckpoint(
  ctx: CheckpointContext, kind: Exclude<CheckpointKind, 'pre-restore'>, label?: string,
): Promise<{ created: boolean; info: CheckpointInfo }> {
  return locked(ctx.sessionId, () => snapshot(ctx, kind, label));
}

/** Newest first. Not locked: a read is allowed to see the state just before or after a take. */
export async function listCheckpoints(ctx: CheckpointContext): Promise<CheckpointInfo[]> {
  const rows = await listRaw(ctx.worktree, ctx.sessionId);
  return Promise.all(rows.map((_, i) => describe(ctx, rows, i)));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/domain/checkpoint.test.ts --max-concurrency=1` then `bun run typecheck`
Expected: PASS (all 10), 0 type errors. If `for-each-ref`'s `%(tree)` is rejected by the installed git, run `git --version`; `%(tree)` has existed since git 1.5 for commits.

- [ ] **Step 5: Stage and propose** — `git add src/domain/checkpoint.ts tests/domain/checkpoint.test.ts`; message `feat(checkpoint): snapshot a session worktree as hidden git commits`.

---

### Task 3: Checkpoint module — diff and restore

**Files:**
- Modify: `src/domain/checkpoint.ts`
- Modify: `tests/domain/checkpoint.test.ts`

**Interfaces:**
- Consumes: Task 2's `snapshot`, `locked`, `liveTree`, `listRaw`, `changesBetween`, `privateIndex`, `git`; `diffBetween`, `TreeDiff`; `assertContained`.
- Produces (exact):
  - `diffCheckpoints(ctx, from: number, to?: number, opts?: { maxPatchBytes?: number }): Promise<TreeDiff>`
  - `interface RestorePlan { write: string[]; delete: string[] }`
  - `restoreCheckpoint(ctx, seq: number, opts?: { apply?: boolean }): Promise<{ plan: RestorePlan; applied: boolean; preRestoreSeq?: number }>`
  - error codes `CHECKPOINT_NOT_FOUND`, plus `PATH_ESCAPE` from `assertContained`.

- [ ] **Step 1: Write the failing tests** — extend the imports of `tests/domain/checkpoint.test.ts` (`diffCheckpoints`, `restoreCheckpoint`; from `node:fs` add `existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, rmSync`) and append:

```ts
describe('diffCheckpoints', () => {
  it('diffs one turn against the previous checkpoint, and a checkpoint against the live worktree', async () => {
    const c1 = (await takeCheckpoint(ctx, 'baseline')).info;
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    const c2 = (await takeCheckpoint(ctx, 'turn')).info;
    writeFileSync(join(wt, 'b.txt'), 'bee2\n');

    const turn = await diffCheckpoints(ctx, c1.seq, c2.seq);
    expect(turn.files).toEqual([{ path: 'a.txt', status: 'modified', added: 1, deleted: 1 }]);
    expect(turn.patch).toContain('+two');

    const since = await diffCheckpoints(ctx, c2.seq);
    expect(since.files.map((f) => f.path)).toEqual(['b.txt']);
    expect(await listCheckpoints(ctx)).toHaveLength(2); // the live side wrote no ref
  });

  it('counts a binary file as 0/0 lines and does not break the parser', async () => {
    const c1 = (await takeCheckpoint(ctx, 'baseline')).info;
    writeFileSync(join(wt, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
    const diff = await diffCheckpoints(ctx, c1.seq);
    expect(diff.files).toEqual([{ path: 'blob.bin', status: 'added', added: 0, deleted: 0 }]);
  });

  it('says CHECKPOINT_NOT_FOUND for a number that does not exist', async () => {
    await expect(diffCheckpoints(ctx, 99)).rejects.toMatchObject({ code: 'CHECKPOINT_NOT_FOUND' });
  });
});

describe('restoreCheckpoint', () => {
  it('previews by default, then restores modified, deleted and added files — and is itself undoable', async () => {
    const cp = (await takeCheckpoint(ctx, 'baseline')).info; // a=one b=bee
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    unlinkSync(join(wt, 'b.txt'));
    mkdirSync(join(wt, 'dir'));
    writeFileSync(join(wt, 'dir', 'c.txt'), 'c\n');

    const preview = await restoreCheckpoint(ctx, cp.seq);
    expect(preview.applied).toBe(false);
    expect(preview.plan).toEqual({ write: ['a.txt', 'b.txt'], delete: ['dir/c.txt'] });
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('two\n'); // a preview changed nothing
    expect(await listCheckpoints(ctx)).toHaveLength(1);            // and recorded nothing

    const done = await restoreCheckpoint(ctx, cp.seq, { apply: true });
    expect(done.applied).toBe(true);
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(wt, 'b.txt'), 'utf8')).toBe('bee\n');
    expect(existsSync(join(wt, 'dir', 'c.txt'))).toBe(false);
    expect(existsSync(join(wt, 'dir'))).toBe(false); // the directory it emptied goes too
    expect(done.preRestoreSeq).toBe(2);
    expect((await listCheckpoints(ctx)).map((c) => c.kind)).toEqual(['pre-restore', 'baseline']);

    await restoreCheckpoint(ctx, done.preRestoreSeq!, { apply: true });
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('two\n');
    expect(existsSync(join(wt, 'b.txt'))).toBe(false);
    expect(existsSync(join(wt, 'dir', 'c.txt'))).toBe(true);
  });

  it('never moves HEAD or the real index, even when the agent committed mid-turn', async () => {
    const cp = (await takeCheckpoint(ctx, 'baseline')).info;
    await commitFile(wt, 'later.txt', 'x\n', 'agent commit');
    writeFileSync(join(wt, 'staged.txt'), 's\n');
    await $`git add staged.txt`.cwd(wt).quiet();
    const head = (await $`git rev-parse HEAD`.cwd(wt).quiet().text()).trim();
    const staged = await $`git diff --cached --name-only`.cwd(wt).quiet().text();

    await restoreCheckpoint(ctx, cp.seq, { apply: true });

    expect((await $`git rev-parse HEAD`.cwd(wt).quiet().text()).trim()).toBe(head);
    expect(await $`git diff --cached --name-only`.cwd(wt).quiet().text()).toBe(staged);
    expect(await $`git log --oneline`.cwd(wt).quiet().text()).toContain('agent commit');
    expect(existsSync(join(wt, 'later.txt'))).toBe(false); // the files go back; the commit stays
  });

  it('leaves ignored files alone', async () => {
    await commitFile(wt, '.gitignore', 'ignored.log\n', 'ignore');
    const cp = (await takeCheckpoint(ctx, 'baseline')).info;
    writeFileSync(join(wt, 'ignored.log'), 'keep me\n');
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    await restoreCheckpoint(ctx, cp.seq, { apply: true });
    expect(readFileSync(join(wt, 'ignored.log'), 'utf8')).toBe('keep me\n');
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('writes nothing outside the worktree when a directory became a symlink', async () => {
    const outside = join(fx.root, 'outside');
    mkdirSync(outside);
    mkdirSync(join(wt, 'dir'));
    writeFileSync(join(wt, 'dir', 'file.txt'), 'orig\n');
    const cp = (await takeCheckpoint(ctx, 'baseline')).info;
    rmSync(join(wt, 'dir'), { recursive: true });
    symlinkSync(outside, join(wt, 'dir'));

    // Either outcome is acceptable — a refusal or a clean restore — but nothing may land outside.
    await restoreCheckpoint(ctx, cp.seq, { apply: true }).catch((e: { code?: string }) => {
      expect(['PATH_ESCAPE', 'CHECKPOINT_GIT_FAILED']).toContain(e.code);
    });
    expect(existsSync(join(outside, 'file.txt'))).toBe(false);
  });

  it('still completes when its own pre-restore checkpoint prunes the target', async () => {
    const small = { ...ctx, keep: 2 };
    writeFileSync(join(wt, 'a.txt'), 'v1\n');
    const target = (await takeCheckpoint(small, 'turn')).info;
    writeFileSync(join(wt, 'a.txt'), 'v2\n');
    await takeCheckpoint(small, 'turn');
    writeFileSync(join(wt, 'a.txt'), 'v3\n');
    const done = await restoreCheckpoint(small, target.seq, { apply: true });
    expect(done.applied).toBe(true);
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('v1\n');
  });

  it('survives awkward file names', async () => {
    writeFileSync(join(wt, 'weird name é.txt'), 'w\n');
    const cp = (await takeCheckpoint(ctx, 'baseline')).info;
    unlinkSync(join(wt, 'weird name é.txt'));
    await restoreCheckpoint(ctx, cp.seq, { apply: true });
    expect(readFileSync(join(wt, 'weird name é.txt'), 'utf8')).toBe('w\n');
  });

  it('says CHECKPOINT_NOT_FOUND for a number that does not exist', async () => {
    await expect(restoreCheckpoint(ctx, 99, { apply: true })).rejects.toMatchObject({ code: 'CHECKPOINT_NOT_FOUND' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/domain/checkpoint.test.ts --max-concurrency=1`
Expected: FAIL — `diffCheckpoints` / `restoreCheckpoint` not exported.

- [ ] **Step 3: Implement** — in `src/domain/checkpoint.ts` change the imports to add `lstatSync, rmdirSync, realpathSync, unlinkSync` from `node:fs`, `assertContained` from `../core/paths.js`, and `diffBetween, type TreeDiff` from `./session-diff.js`; then append:

```ts
function findRaw(rows: Raw[], seq: number): Raw {
  const row = rows.find((r) => r.seq === seq);
  if (row === undefined) throw new CrossweaveError('CHECKPOINT_NOT_FOUND', `No checkpoint #${seq} for this session.`);
  return row;
}

/** `to` omitted compares with the live worktree; that side is an unreferenced tree, so it leaves no ref behind. */
export async function diffCheckpoints(
  ctx: CheckpointContext, from: number, to?: number, opts: { maxPatchBytes?: number } = {},
): Promise<TreeDiff> {
  const rows = await listRaw(ctx.worktree, ctx.sessionId);
  const a = findRaw(rows, from).tree;
  const b = to === undefined ? await locked(ctx.sessionId, () => liveTree(ctx)) : findRaw(rows, to).tree;
  return diffBetween(ctx.worktree, a, b, opts);
}

export interface RestorePlan { write: string[]; delete: string[] }

function planOf(changes: TreeChange[]): RestorePlan {
  // Going from "now" to the target: an added path is one the target has and the worktree lacks (write it), a
  // deleted path is one the worktree has and the target lacks (remove it), a modified one is written back.
  return {
    write: changes.filter((c) => c.status !== 'D').map((c) => c.path),
    delete: changes.filter((c) => c.status === 'D').map((c) => c.path),
  };
}

export function restoreCheckpoint(
  ctx: CheckpointContext, seq: number, opts: { apply?: boolean } = {},
): Promise<{ plan: RestorePlan; applied: boolean; preRestoreSeq?: number }> {
  return locked(ctx.sessionId, async () => {
    const target = findRaw(await listRaw(ctx.worktree, ctx.sessionId), seq);
    if (opts.apply !== true) {
      // Dry run is the default and writes nothing — not even a ref.
      const plan = planOf(await changesBetween(ctx.worktree, await liveTree(ctx), target.tree));
      return { plan, applied: false };
    }
    // The way back: if the tree is unchanged the newest checkpoint already is that point.
    const pre = await snapshot(ctx, 'pre-restore', `before restoring #${seq}`);
    const plan = planOf(await changesBetween(ctx.worktree, pre.info.tree, target.tree));

    // Everything is validated before anything is touched, so a bad path aborts with the worktree as it was.
    const doomed = plan.delete.map((p) => assertContained(ctx.worktree, p));
    for (const p of plan.write) assertContained(ctx.worktree, p);

    const root = realpathSync(ctx.worktree);
    // Deletes first: a file that became a directory (or the reverse) needs the old entry gone before the new one lands.
    for (const abs of doomed) {
      try { lstatSync(abs); unlinkSync(abs); } catch { continue; }
      for (let dir = dirname(abs); dir.length > root.length; dir = dirname(dir)) {
        try { rmdirSync(dir); } catch { break; } // not empty (or already gone): stop climbing
      }
    }
    if (plan.write.length > 0) {
      const index = await privateIndex(ctx);
      await git(ctx.worktree, ['read-tree', target.tree], { GIT_INDEX_FILE: index });
      // Only the paths in the plan: `-a` would rewrite every file, bump every mtime and wake every watcher.
      for (let i = 0; i < plan.write.length; i += 200) {
        await git(ctx.worktree, ['checkout-index', '-f', '--', ...plan.write.slice(i, i + 200)], { GIT_INDEX_FILE: index });
      }
    }
    return { plan, applied: true, preRestoreSeq: pre.info.seq };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/domain/checkpoint.test.ts --max-concurrency=1` then `bun run typecheck`
Expected: PASS, 0 type errors. If the symlink test reports a file under `outside/`, STOP: that is a real escape — fix the implementation (never loosen the test) and tell the owner.

- [ ] **Step 5: Stage and propose** — `git add src/domain/checkpoint.ts tests/domain/checkpoint.test.ts`; message `feat(checkpoint): diff a turn and restore files from a checkpoint, dry-run by default`.

---

### Task 4: Cleanup — delete and prune a session's checkpoints

**Files:**
- Modify: `src/domain/checkpoint.ts`, `src/domain/session.ts`, `src/domain/gc.ts`, `src/convergence/land.ts`
- Modify: `tests/domain/checkpoint.test.ts`
- Test: `tests/daemon/methods-checkpoint.test.ts` (created in Task 5; its removal test is written there)

**Interfaces:**
- Produces: `deleteSessionCheckpoints(projectRoot: string, sessionId: string): Promise<void>` and `pruneOrphans(projectRoot: string, live: ReadonlySet<string>): Promise<void>`. Both best effort for callers (`.catch(() => undefined)`).

- [ ] **Step 1: Write the failing tests** — add `deleteSessionCheckpoints, pruneOrphans` to the imports and append to `tests/domain/checkpoint.test.ts`:

```ts
describe('cleanup', () => {
  it('deleteSessionCheckpoints removes every ref and the private index, and only that session\'s', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    await takeCheckpoint(ctx, 'turn');
    const other = { ...ctx, sessionId: 's_other' };
    await takeCheckpoint(other, 'turn');

    await deleteSessionCheckpoints(fx.root, ctx.sessionId);

    expect(await listCheckpoints(ctx)).toHaveLength(0);
    expect(await listCheckpoints(other)).toHaveLength(1);
    expect(existsSync(join(fx.root, '.crossweave', 'checkpoint-index', ctx.sessionId))).toBe(false);
  });

  it('pruneOrphans drops sessions that no longer exist and keeps live ones', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    await takeCheckpoint(ctx, 'turn');
    const ghost = { ...ctx, sessionId: 's_ghost' };
    await takeCheckpoint(ghost, 'turn');

    await pruneOrphans(fx.root, new Set([ctx.sessionId]));

    expect(await listCheckpoints(ctx)).toHaveLength(1);
    expect(await listCheckpoints(ghost)).toHaveLength(0);
    expect(existsSync(join(fx.root, '.crossweave', 'checkpoint-index', 's_ghost'))).toBe(false);
  });

  it('deleting a session that never had checkpoints is a no-op', async () => {
    await expect(deleteSessionCheckpoints(fx.root, 's_never')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/domain/checkpoint.test.ts --max-concurrency=1`
Expected: FAIL — the two functions are not exported.

- [ ] **Step 3: Implement** — in `src/domain/checkpoint.ts` add `readdirSync, unlinkSync` to the `node:fs` import (merge with Task 3's) and append:

```ts
/** Runs in the project root, not the worktree: the worktree may be about to vanish, the repository does not. */
export function deleteSessionCheckpoints(projectRoot: string, sessionId: string): Promise<void> {
  return locked(sessionId, async () => {
    const out = await git(projectRoot, ['for-each-ref', '--format=%(refname)', refPrefix(sessionId)]);
    for (const ref of out.split('\n')) if (ref !== '') await git(projectRoot, ['update-ref', '-d', ref]);
    try { unlinkSync(indexPath(projectRoot, sessionId)); } catch { /* none was ever made */ }
  });
}

/** `gc`'s tidy-up for what a crash or a hand-deleted worktree left: refs and index files of sessions that are gone. */
export async function pruneOrphans(projectRoot: string, live: ReadonlySet<string>): Promise<void> {
  const out = await git(projectRoot, ['for-each-ref', '--format=%(refname)', `${REF_ROOT}/`]);
  for (const ref of out.split('\n')) {
    if (ref === '') continue;
    const id = ref.split('/')[3];
    if (id !== undefined && !live.has(id)) await git(projectRoot, ['update-ref', '-d', ref]);
  }
  const dir = join(crossweaveDir(projectRoot), 'checkpoint-index');
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) if (!live.has(name)) { try { unlinkSync(join(dir, name)); } catch { /* raced with another cleanup */ } }
}
```

Then wire the four removal sites (each best effort — a failed cleanup must never block a removal). Add `import { deleteSessionCheckpoints } from './checkpoint.js';` (`../domain/checkpoint.js` in `land.ts`) and:

- `src/domain/session.ts`, in `kill()` right after `await removeWorktree(root, ownWorktree);`:
  ```ts
        await deleteSessionCheckpoints(root, row.id).catch(() => undefined);
  ```
- `src/domain/session.ts`, in `remove()` right after `await removeWorktree(root, ownWorktree).catch(() => undefined);`:
  ```ts
      await deleteSessionCheckpoints(root, row.id).catch(() => undefined);
  ```
- `src/domain/gc.ts`, in `reclaimEnded` right after `await removeWorktree(workspace.rootPath, own).catch(() => undefined);`:
  ```ts
      await deleteSessionCheckpoints(workspace.rootPath, session.id).catch(() => undefined);
  ```
- `src/convergence/land.ts`, right after the `if (ownWorktree !== null) { ... }` block that removes the worktree (before `deps.leaseManager.release(sessionId);`):
  ```ts
    await deleteSessionCheckpoints(deps.projectRoot, sessionId).catch(() => undefined);
  ```
- `src/domain/gc.ts`, in `collectGarbage` right after `const orphans = await sweepOrphans(db, workspace, ended.disposedPaths);` (imports: `pruneOrphans` alongside, `SessionRepo` is already imported):
  ```ts
  await pruneOrphans(workspace.rootPath, new Set(new SessionRepo(db).listByWorkspace(workspace.id).map((s) => s.id))).catch(() => undefined);
  ```

- [ ] **Step 4: Run to verify it passes**

Run, one at a time: `bun test tests/domain/checkpoint.test.ts --max-concurrency=1`, `bun test tests/domain tests/convergence --max-concurrency=1`, `bun run typecheck`
Expected: PASS everywhere (the existing session/gc/land tests prove the wiring did not regress removal).

- [ ] **Step 5: Stage and propose** — `git add src/domain src/convergence tests/domain`; message `feat(checkpoint): drop a session's checkpoints when its worktree goes, and prune orphans in gc`.

---

### Task 5: Daemon — turn trigger and `checkpoint.*` RPCs

**Files:**
- Create: `src/daemon/checkpoint-trigger.ts`
- Modify: `src/daemon/session-status.ts`, `src/daemon/methods.ts`
- Test: `tests/daemon/checkpoint-trigger.test.ts` (create), `tests/daemon/session-status.test.ts` (extend), `tests/daemon/methods-checkpoint.test.ts` (create)

**Interfaces:**
- Consumes: Task 2–4 exports; `ActivityTracker`; `num`/`str`/`bool` helpers already in `methods.ts`.
- Produces:
  - `checkpointKindFor(from: Activity, to: Activity): 'baseline' | 'turn' | null`
  - `ActivityTracker.onChange?: (id: string, from: Activity, to: Activity) => void` (public field, called from `sweep`)
  - RPCs `checkpoint.list` → `{ checkpoints: CheckpointInfo[] }`; `checkpoint.take {label?}` → `CheckpointInfo | { unchanged: true; seq: number }`; `checkpoint.diff {from, to?}` → `TreeDiff`; `checkpoint.restore {seq, apply?, force?}` → `{ plan, applied, preRestoreSeq? }`. All take `{ workspaceId, idOrName }`.
  - New error codes: `CHECKPOINT_NO_WORKTREE`, `CHECKPOINT_SESSION_BUSY`.

- [ ] **Step 1: Write the failing tests.**

`tests/daemon/checkpoint-trigger.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { checkpointKindFor } from '../../src/daemon/checkpoint-trigger.js';

describe('checkpointKindFor', () => {
  it('a turn ending (working → idle/asked) takes a turn checkpoint', () => {
    expect(checkpointKindFor('working', 'idle')).toBe('turn');
    expect(checkpointKindFor('working', 'asked')).toBe('turn');
  });
  it('work starting takes a baseline candidate (the caller skips it when checkpoints exist)', () => {
    expect(checkpointKindFor('idle', 'working')).toBe('baseline');
    expect(checkpointKindFor('asked', 'working')).toBe('baseline');
  });
  it('a failure, or any other move, takes nothing', () => {
    expect(checkpointKindFor('working', 'failed')).toBeNull();
    expect(checkpointKindFor('idle', 'asked')).toBeNull();
    expect(checkpointKindFor('idle', 'idle')).toBeNull();
  });
});
```

Append to `tests/daemon/session-status.test.ts` (inside the file's top-level, after the existing `describe('ActivityTracker', ...)` closes — a new `describe`):

```ts
describe('ActivityTracker.onChange', () => {
  it('reports from and to for each session that moved at a sweep, and nothing when nothing moved', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    const seen: Array<[string, string, string]> = [];
    t.onChange = (id, from, to) => { seen.push([id, from, to]); };
    t.started('s');
    t.input('s');
    t.output('s', 'total 8\r\n');
    t.sweep(() => null, () => null);
    c.advance(2500);
    t.sweep(() => null, () => null);
    t.sweep(() => null, () => null);
    expect(seen).toEqual([['s', 'idle', 'working'], ['s', 'working', 'idle']]);
  });
});
```

`tests/daemon/methods-checkpoint.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

const codeOf = async (fn: () => unknown): Promise<string> => { try { await fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };

async function setup() {
  const fx = await makeGitFixture();
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  const ctx = { notify: () => undefined, onClose: () => undefined };
  const methods = buildMethods(db, fx.root);
  const call = (m: string, p: Record<string, unknown> = {}): Promise<any> => methods[m]!({ workspaceId: ws.id, ...p }, ctx) as Promise<any>;
  return { fx, db, call, cleanup: async () => { db.close(); await fx.cleanup(); } };
}

describe('checkpoint RPCs', () => {
  test('take, list, diff and a dry-run then applied restore round-trip over the RPC shapes', async () => {
    const t = await setup();
    try {
      const row = await t.call('session.new', { name: 'dev' }) as { worktreePath: string };
      writeFileSync(join(row.worktreePath, 'README.md'), 'one\n');
      const first = await t.call('checkpoint.take', { idOrName: 'dev', label: 'start' });
      expect(first.seq).toBe(1);
      expect((await t.call('checkpoint.take', { idOrName: 'dev' })).unchanged).toBe(true);

      writeFileSync(join(row.worktreePath, 'README.md'), 'two\n');
      const list = await t.call('checkpoint.list', { idOrName: 'dev' });
      expect(list.checkpoints.map((c: { seq: number }) => c.seq)).toEqual([1]);

      const diff = await t.call('checkpoint.diff', { idOrName: 'dev', from: 1 });
      expect(diff.files.map((f: { path: string }) => f.path)).toEqual(['README.md']);

      const preview = await t.call('checkpoint.restore', { idOrName: 'dev', seq: 1 });
      expect(preview).toEqual({ plan: { write: ['README.md'], delete: [] }, applied: false });
      const done = await t.call('checkpoint.restore', { idOrName: 'dev', seq: 1, apply: true });
      expect(done.applied).toBe(true);
      expect(typeof done.preRestoreSeq).toBe('number');
    } finally { await t.cleanup(); }
  }, 30_000);

  test('a session in the project folder has no worktree to checkpoint', async () => {
    const t = await setup();
    try {
      await t.call('session.new', { name: 'shared', worktree: false });
      expect(await codeOf(() => t.call('checkpoint.take', { idOrName: 'shared' }))).toBe('CHECKPOINT_NO_WORKTREE');
    } finally { await t.cleanup(); }
  }, 30_000);

  test('bad params are refused, not run', async () => {
    const t = await setup();
    try {
      await t.call('session.new', { name: 'dev' });
      expect(await codeOf(() => t.call('checkpoint.restore', { idOrName: 'dev' }))).toBe('INVALID_PARAMS');
      expect(await codeOf(() => t.call('checkpoint.restore', { idOrName: 'dev', seq: 7, apply: true }))).toBe('CHECKPOINT_NOT_FOUND');
    } finally { await t.cleanup(); }
  }, 30_000);

  test('removing the session removes its checkpoints', async () => {
    const t = await setup();
    try {
      const row = await t.call('session.new', { name: 'dev' }) as { worktreePath: string };
      writeFileSync(join(row.worktreePath, 'README.md'), 'one\n');
      await t.call('checkpoint.take', { idOrName: 'dev' });
      expect((await $`git for-each-ref refs/crossweave`.cwd(t.fx.root).quiet().text()).trim()).not.toBe('');
      await t.call('session.kill', { idOrName: 'dev', removeWorktree: true });
      expect((await $`git for-each-ref refs/crossweave`.cwd(t.fx.root).quiet().text()).trim()).toBe('');
      expect(existsSync(join(t.fx.root, '.crossweave', 'checkpoint-index'))).toBe(true); // the dir stays; its file went
    } finally { await t.cleanup(); }
  }, 30_000);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/daemon/checkpoint-trigger.test.ts tests/daemon/session-status.test.ts tests/daemon/methods-checkpoint.test.ts --max-concurrency=1`
Expected: FAIL — module/field/methods missing. (None of these tests start a pty, so they run inside the sandbox. If `session.new` with `worktree: false` is refused by the daemon, read how `tests/daemon/methods-plain.test.ts` creates a shared session and use that call.)

- [ ] **Step 3: Implement.**

`src/daemon/checkpoint-trigger.ts`:

```ts
import type { Activity } from './session-status.js';

/**
 * Which checkpoint, if any, a status move calls for. `working → idle|asked` is a turn ending; `→ working` is the
 * moment the agent starts, the last chance to save the "before" of a session that has no checkpoint yet (the caller
 * checks that). A failure takes nothing: the shell broke, no turn finished.
 */
export function checkpointKindFor(from: Activity, to: Activity): 'baseline' | 'turn' | null {
  if (from === 'working' && (to === 'idle' || to === 'asked')) return 'turn';
  if (from !== 'working' && to === 'working') return 'baseline';
  return null;
}
```

`src/daemon/session-status.ts` — add the field to `ActivityTracker` (next to `private readonly bySession`):

```ts
  /** Called once per session whose activity moved at a sweep; never allowed to throw into it. */
  onChange?: (id: string, from: Activity, to: Activity) => void;
```

and in `sweep`, replace the `if (now !== t.reported) { ... }` block with:

```ts
      if (now !== t.reported) {
        const from = t.reported;
        t.reported = now;
        changed.push(id);
        try { this.onChange?.(id, from, now); } catch { /* a listener must not break the sweep */ }
      }
```

`src/daemon/methods.ts` — add imports:

```ts
import { diffCheckpoints, listCheckpoints, restoreCheckpoint, takeCheckpoint, type CheckpointContext } from '../domain/checkpoint.js';
import { checkpointKindFor } from './checkpoint-trigger.js';
```

Right after `const activity = new ActivityTracker(opts.now);` add:

```ts
  /** The context for a session's checkpoints: only a session with a worktree of its own has one. */
  function checkpointContextFor(row: SessionRow): CheckpointContext {
    if (!hasGit || row.worktreePath === null || row.worktreePath === projectRoot || !existsSync(row.worktreePath)) {
      throw new CrossweaveError('CHECKPOINT_NO_WORKTREE', `${row.name} has no worktree of its own to checkpoint.`);
    }
    return { projectRoot, sessionId: row.id, worktree: row.worktreePath };
  }

  /** Fire-and-forget from the sweep: a vanished worktree or a full disk is logged, never thrown into it. */
  async function autoCheckpoint(sessionId: string, kind: 'baseline' | 'turn'): Promise<void> {
    try {
      const row = sessionsRepo.findById(sessionId);
      if (row === undefined) return;
      const ctx = checkpointContextFor(row);
      if (kind === 'baseline' && (await listCheckpoints(ctx)).length > 0) return;
      await takeCheckpoint(ctx, kind);
    } catch (err) {
      daemonLog(`checkpoint (${kind}) for ${sessionId} skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  activity.onChange = (id, from, to) => {
    const kind = checkpointKindFor(from, to);
    if (kind !== null) void autoCheckpoint(id, kind);
  };
```

Then add the four handlers to the method table, next to `'session.diff'`:

```ts
    'checkpoint.list': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      return { checkpoints: await listCheckpoints(checkpointContextFor(row)) };
    },
    'checkpoint.take': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      const { created, info } = await takeCheckpoint(checkpointContextFor(row), 'manual', optionalStr(p, 'label'));
      return created ? info : { unchanged: true, seq: info.seq };
    },
    'checkpoint.diff': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      return diffCheckpoints(checkpointContextFor(row), num(p, 'from'), typeof p['to'] === 'number' ? p['to'] : undefined);
    },
    'checkpoint.restore': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      const apply = p['apply'] === true;
      if (apply && p['force'] !== true) {
        // The status is inferred, so a person who knows better has `force`.
        const live = activity.status(row.id, agents.get(row.id) ?? null, (terminalId) => terminalAgents.get(terminalId) ?? null);
        if (live.activity === 'working') {
          throw new CrossweaveError('CHECKPOINT_SESSION_BUSY', `${row.name} looks busy; restoring files under a running agent can fight it. Retry with force.`);
        }
      }
      const result = await restoreCheckpoint(checkpointContextFor(row), num(p, 'seq'), { apply });
      if (result.applied) broadcastRegistry.broadcast('tui.invalidate', {});
      return result;
    },
```

(`num` throws `INVALID_PARAMS` for a missing number — the test above relies on it. Confirm with `sed -n 83,92p src/daemon/methods.ts`; if it throws a different code, change the test's expected code, not the helper.)

- [ ] **Step 4: Run to verify they pass**

Run, one at a time: `bun test tests/daemon/checkpoint-trigger.test.ts tests/daemon/session-status.test.ts tests/daemon/methods-checkpoint.test.ts --max-concurrency=1`, then `bun run typecheck`.
Expected: PASS, 0 type errors. Then `bun test tests/daemon --max-concurrency=1` — pty-dependent files may report `Failed to open PTY` inside the sandbox; that is environmental (`AGENTS.md`): re-run those outside the sandbox and report which ones.

- [ ] **Step 5: Stage and propose** — `git add src/daemon tests/daemon`; message `feat(daemon): checkpoint each finished agent turn and serve checkpoint.* RPCs`.

---

### Task 6: `cw checkpoint`

**Files:**
- Create: `src/cli/commands/checkpoint.ts`, `tests/cli/checkpoint.test.ts`
- Modify: `src/cli/index.ts`

**Interfaces:**
- Consumes: the RPCs of Task 5; `withClient`, `currentWorkspaceId`, `fail` from `../context.js`.
- Produces: pure `formatCheckpoint(c: CliCheckpoint): string` and `formatPlan(plan: { write: string[]; delete: string[] }): string` (exported for tests), and `checkpointCommand`.

- [ ] **Step 1: Write the failing test** — `tests/cli/checkpoint.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { formatCheckpoint, formatPlan } from '../../src/cli/commands/checkpoint.js';

describe('formatCheckpoint', () => {
  it('one line: number, kind, label, and +added ~modified -deleted', () => {
    expect(formatCheckpoint({ seq: 3, kind: 'turn', at: 0, head: 'abc', tree: 't', files: { added: 1, modified: 2, deleted: 0 } }))
      .toBe('#3  turn  +1 ~2 -0');
    expect(formatCheckpoint({ seq: 4, kind: 'manual', label: 'before refactor', at: 0, head: 'abc', tree: 't', files: { added: 0, modified: 0, deleted: 1 } }))
      .toBe('#4  manual  before refactor  +0 ~0 -1');
  });
});

describe('formatPlan', () => {
  it('lists what would be written and deleted, and says so when there is nothing', () => {
    expect(formatPlan({ write: ['a.txt'], delete: ['b.txt'] })).toBe('write a.txt\ndelete b.txt');
    expect(formatPlan({ write: [], delete: [] })).toBe('nothing to change');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/cli/checkpoint.test.ts --max-concurrency=1`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/cli/commands/checkpoint.ts`:

```ts
import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { currentWorkspaceId, fail, withClient } from '../context.js';

export interface CliCheckpoint {
  seq: number;
  kind: string;
  label?: string;
  at: number;
  head: string;
  tree: string;
  files: { added: number; modified: number; deleted: number };
}

export function formatCheckpoint(c: CliCheckpoint): string {
  const counts = `+${c.files.added} ~${c.files.modified} -${c.files.deleted}`;
  return `#${c.seq}  ${c.kind}  ${c.label === undefined ? '' : `${c.label}  `}${counts}`;
}

export function formatPlan(plan: { write: string[]; delete: string[] }): string {
  const lines = [...plan.write.map((p) => `write ${p}`), ...plan.delete.map((p) => `delete ${p}`)];
  return lines.length === 0 ? 'nothing to change' : lines.join('\n');
}

function sessionArg(args: { session?: unknown }): string {
  const idOrName = (typeof args.session === 'string' && args.session !== '' ? args.session : undefined) ?? process.env['CW_SESSION_ID'];
  if (idOrName === undefined || idOrName === '') throw new CrossweaveError('INVALID_ARGUMENTS', 'Name the session: cw checkpoint <verb> [session] (or run this from a session shell)');
  return idOrName;
}

function seqArg(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new CrossweaveError('INVALID_ARGUMENTS', `${what} must be a checkpoint number, like 3`);
  return n;
}

const session = { type: 'positional', required: false, description: 'Session name or id (default: this shell\'s own session)' } as const;

export const checkpointCommand = defineCommand({
  meta: { name: 'checkpoint', description: 'Snapshots of a session\'s worktree, taken when its agent finishes a turn: list them, diff a turn, take the files back' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List a session\'s checkpoints, newest first' },
      args: { session },
      async run({ args }) {
        try {
          const idOrName = sessionArg(args);
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const out = await client.call<{ checkpoints: CliCheckpoint[] }>('checkpoint.list', { workspaceId, idOrName });
            process.stdout.write(out.checkpoints.length === 0 ? 'no checkpoints yet\n' : `${out.checkpoints.map(formatCheckpoint).join('\n')}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
    take: defineCommand({
      meta: { name: 'take', description: 'Take a checkpoint now' },
      args: { session, label: { type: 'string', description: 'A short note for this checkpoint' } },
      async run({ args }) {
        try {
          const idOrName = sessionArg(args);
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const out = await client.call<CliCheckpoint | { unchanged: true; seq: number }>('checkpoint.take', {
              workspaceId, idOrName, ...(typeof args.label === 'string' ? { label: args.label } : {}),
            });
            process.stdout.write('unchanged' in out ? `unchanged since #${out.seq}\n` : `${formatCheckpoint(out)}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
    diff: defineCommand({
      meta: { name: 'diff', description: 'Print the patch between two checkpoints, or from one to the worktree as it is now' },
      args: {
        from: { type: 'positional', required: true, description: 'Checkpoint number' },
        to: { type: 'positional', required: false, description: 'Checkpoint number (default: the live worktree)' },
        session: { type: 'string', description: 'Session name or id (default: this shell\'s own session)' },
      },
      async run({ args }) {
        try {
          const idOrName = sessionArg(args);
          const from = seqArg(args.from, 'from');
          const to = args.to === undefined ? undefined : seqArg(args.to, 'to');
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const out = await client.call<{ patch: string; truncated: boolean }>('checkpoint.diff', { workspaceId, idOrName, from, ...(to === undefined ? {} : { to }) });
            process.stdout.write(out.patch === '' ? 'no differences\n' : out.patch);
            if (out.truncated) process.stderr.write('(patch cut at 512 KB)\n');
          });
        } catch (err) { fail(err); }
      },
    }),
    restore: defineCommand({
      meta: { name: 'restore', description: 'Put a checkpoint\'s files back. Prints the plan; nothing is written without --apply. A return point is saved first' },
      args: {
        seq: { type: 'positional', required: true, description: 'Checkpoint number' },
        session: { type: 'string', description: 'Session name or id (default: this shell\'s own session)' },
        apply: { type: 'boolean', default: false, description: 'Actually write the files' },
        force: { type: 'boolean', default: false, description: 'Restore even though the session looks busy' },
      },
      async run({ args }) {
        try {
          const idOrName = sessionArg(args);
          const seq = seqArg(args.seq, 'seq');
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const out = await client.call<{ plan: { write: string[]; delete: string[] }; applied: boolean; preRestoreSeq?: number }>(
              'checkpoint.restore', { workspaceId, idOrName, seq, apply: args.apply === true, force: args.force === true },
            );
            process.stdout.write(`${formatPlan(out.plan)}\n`);
            if (out.applied) process.stdout.write(`restored #${seq}; to undo: cw checkpoint restore ${out.preRestoreSeq ?? '?'} --apply\n`);
            else process.stdout.write(`preview only — add --apply to write these files\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
  },
});
```

In `src/cli/index.ts` add `import { checkpointCommand } from './commands/checkpoint.js';` beside the `checkCommand` import and `checkpoint: checkpointCommand,` after `check: checkCommand,` in `subCommands`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/cli/checkpoint.test.ts tests/cli/cli.test.ts --max-concurrency=1` then `bun run typecheck`
Expected: PASS, 0 type errors. (`cli.test.ts` guards the command list/help; if it pins the subcommand list, add `checkpoint` to its expectation — that is a legitimate contract change.)

- [ ] **Step 5: Stage and propose** — `git add src/cli tests/cli`; message `feat(cli): cw checkpoint list|take|diff|restore`.

---

### Task 7: Cockpit — channels, parsing, dialog, menu entry

**Files:**
- Modify: `apps/cockpit/electron/channels.ts`, `apps/cockpit/src/host/cockpit-api.ts`, `apps/cockpit/src/ui/Sidebar.tsx`, `apps/cockpit/src/ui/ProjectView.tsx`, `apps/cockpit/src/ui/app.css`
- Create: `apps/cockpit/src/lib/checkpoints.ts`, `apps/cockpit/src/ui/CheckpointsDialog.tsx`
- Test: `apps/cockpit/tests/checkpoints.test.tsx` (create), `apps/cockpit/tests/channels.test.ts` (extend)

**Interfaces:**
- Produces (exact):
  - `lib/checkpoints.ts`: `type Checkpoint = { seq: number; kind: 'baseline'|'turn'|'manual'|'pre-restore'; label?: string; at: number; head: string; files: { added: number; modified: number; deleted: number } }`, `type RestorePlan = { write: string[]; delete: string[] }`, `parseCheckpoints(value: unknown): Checkpoint[]`, `parseRestorePlan(value: unknown): RestorePlan`, `describeRestore(seq: number, plan: RestorePlan, working: boolean): { title: string; body: string }`.
  - `cockpit-api`: `checkpoints(idOrName): Promise<Checkpoint[]>`, `takeCheckpoint(idOrName): Promise<unknown>`, `checkpointDiff(idOrName, from, to?): Promise<CheckpointDiff>`, `previewRestore(idOrName, seq): Promise<RestorePlan>`, `restoreCheckpoint(idOrName, seq): Promise<unknown>`; `type CheckpointDiff = Omit<SessionDiff, 'uncommitted'>`.
  - `RowAction` gains `'checkpoints'`.

- [ ] **Step 1: Write the failing tests.**

`apps/cockpit/tests/checkpoints.test.tsx`:

```tsx
/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import type { ComponentChildren, VNode } from 'preact'
import { describeRestore, parseCheckpoints, parseRestorePlan } from '../src/lib/checkpoints'
import { CheckpointList } from '../src/ui/CheckpointsDialog'

type Found = { texts: string[]; nodes: VNode[] }
function walk(node: ComponentChildren, out: Found = { texts: [], nodes: [] }): Found {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  const vnode = node as VNode<Record<string, unknown>>
  if (typeof vnode.type === 'function') return walk((vnode.type as (props: unknown) => ComponentChildren)(vnode.props), out)
  out.nodes.push(vnode)
  return walk(vnode.props['children'] as ComponentChildren, out)
}
const text = (f: Found): string => f.texts.join(' ').replace(/\s+/g, ' ')

describe('parseCheckpoints', () => {
  test('keeps well-formed rows, newest first as sent, and drops malformed ones', () => {
    const out = parseCheckpoints({ checkpoints: [
      { seq: 2, kind: 'turn', at: 20, head: 'abc', files: { added: 1, modified: 0, deleted: 0 } },
      { seq: 'x', kind: 'turn', at: 1, head: 'abc', files: {} },
      { seq: 1, kind: 'bogus', at: 1, head: 'abc', files: {} },
      { seq: 1, kind: 'manual', label: 'start', at: 10, head: 'abc', files: { added: 0, modified: 2, deleted: 1 } },
    ] })
    expect(out.map((c) => c.seq)).toEqual([2, 1])
    expect(out[1]?.label).toBe('start')
    expect(out[1]?.files).toEqual({ added: 0, modified: 2, deleted: 1 })
  })
  test('anything that is not the expected shape is an empty list', () => {
    expect(parseCheckpoints(null)).toEqual([])
    expect(parseCheckpoints({ checkpoints: 'no' })).toEqual([])
  })
})

describe('parseRestorePlan', () => {
  test('takes the plan out of a restore reply, or an empty one', () => {
    expect(parseRestorePlan({ plan: { write: ['a'], delete: ['b'] }, applied: false })).toEqual({ write: ['a'], delete: ['b'] })
    expect(parseRestorePlan({ plan: { write: [1], delete: 'x' } })).toEqual({ write: [], delete: [] })
    expect(parseRestorePlan(undefined)).toEqual({ write: [], delete: [] })
  })
})

describe('describeRestore', () => {
  test('names what changes, promises the return point, and warns about a busy session', () => {
    const plan = { write: ['a.txt', 'b.txt'], delete: ['c.txt'] }
    const calm = describeRestore(3, plan, false)
    expect(calm.title).toBe('Restore checkpoint #3?')
    expect(calm.body).toContain('Write 2 files, delete 1 file.')
    expect(calm.body).toContain('a.txt')
    expect(calm.body).toContain('A return point is saved first.')
    expect(calm.body).not.toContain('looks busy')
    expect(describeRestore(3, plan, true).body).toContain('looks busy')
  })
  test('lists at most 8 paths and counts the rest', () => {
    const plan = { write: Array.from({ length: 12 }, (_, i) => `f${i}.txt`), delete: [] }
    const body = describeRestore(1, plan, false).body
    expect(body).toContain('f7.txt')
    expect(body).not.toContain('f8.txt')
    expect(body).toContain('and 4 more')
  })
  test('says plainly when there is nothing to change', () => {
    expect(describeRestore(1, { write: [], delete: [] }, false).body).toContain('Nothing to change')
  })
})

describe('CheckpointList', () => {
  const noop = () => undefined
  test('says there are none yet', () => {
    expect(text(walk(<CheckpointList rows={[]} now={0} onTurn={noop} onSince={noop} onRestore={noop} />))).toContain('No checkpoints yet')
  })
  test('shows number, kind, label and counts, and disables "This turn" on the oldest row', () => {
    const rows = [
      { seq: 2, kind: 'turn' as const, at: 20, head: 'a', files: { added: 1, modified: 2, deleted: 0 } },
      { seq: 1, kind: 'baseline' as const, label: 'start', at: 10, head: 'a', files: { added: 0, modified: 0, deleted: 0 } },
    ]
    const found = walk(<CheckpointList rows={rows} now={30} onTurn={noop} onSince={noop} onRestore={noop} />)
    expect(text(found)).toContain('#2')
    expect(text(found)).toContain('turn')
    expect(text(found)).toContain('start')
    expect(text(found)).toContain('+1 ~2 −0')
    const turnButtons = found.nodes.filter((n) => n.type === 'button' && JSON.stringify(n.props['children']).includes('This turn'))
    expect(turnButtons.map((b) => b.props['disabled'])).toEqual([false, true])
  })
})
```

Extend `apps/cockpit/tests/channels.test.ts` with:

```ts
  test('lets the renderer use the checkpoint calls', () => {
    for (const name of ['checkpoint.list', 'checkpoint.take', 'checkpoint.diff', 'checkpoint.restore']) {
      expect(isCockpitChannel(name)).toBe(true)
    }
  })
```
(inside the existing `describe('cockpit IPC allowlist', ...)`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/cockpit && bun test tests/checkpoints.test.tsx tests/channels.test.ts --max-concurrency=1`
Expected: FAIL — modules/channels missing. (`cd` back to the repo root afterwards.)

- [ ] **Step 3: Implement.**

`apps/cockpit/electron/channels.ts` — after `'session.diff',` add:

```ts
  'checkpoint.list',
  'checkpoint.take',
  'checkpoint.diff',
  'checkpoint.restore',
```

`apps/cockpit/src/lib/checkpoints.ts`:

```ts
import type { SessionDiff } from './patch'

export type CheckpointKind = 'baseline' | 'turn' | 'manual' | 'pre-restore'
export type Checkpoint = {
  seq: number
  kind: CheckpointKind
  label?: string
  at: number
  head: string
  files: { added: number; modified: number; deleted: number }
}
export type RestorePlan = { write: string[]; delete: string[] }
/** `checkpoint.diff`'s answer: a `session.diff` without the uncommitted count (a checkpoint has no such notion). */
export type CheckpointDiff = Omit<SessionDiff, 'uncommitted'>

const KINDS: readonly string[] = ['baseline', 'turn', 'manual', 'pre-restore']
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** `{ checkpoints: [...] }` from the daemon, or anything malformed → []. */
export function parseCheckpoints(value: unknown): Checkpoint[] {
  const list = (value as { checkpoints?: unknown } | null)?.checkpoints
  if (!Array.isArray(list)) return []
  const out: Checkpoint[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const r = item as Record<string, unknown>
    if (typeof r.seq !== 'number' || !Number.isInteger(r.seq) || r.seq < 1) continue
    if (typeof r.kind !== 'string' || !KINDS.includes(r.kind)) continue
    const files = (r.files ?? {}) as Record<string, unknown>
    out.push({
      seq: r.seq,
      kind: r.kind as CheckpointKind,
      ...(typeof r.label === 'string' && r.label !== '' ? { label: r.label } : {}),
      at: count(r.at),
      head: typeof r.head === 'string' ? r.head : '',
      files: { added: count(files.added), modified: count(files.modified), deleted: count(files.deleted) },
    })
  }
  return out
}

const strings = (v: unknown): string[] => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : [])

/** The plan out of a `checkpoint.restore` reply (a preview or an applied one); malformed → nothing to do. */
export function parseRestorePlan(value: unknown): RestorePlan {
  const plan = (value as { plan?: { write?: unknown; delete?: unknown } } | null | undefined)?.plan
  return { write: strings(plan?.write), delete: strings(plan?.delete) }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The confirmation's words: what changes, that the way back is saved first, and a warning while an agent works. */
export function describeRestore(seq: number, plan: RestorePlan, working: boolean): { title: string; body: string } {
  const title = `Restore checkpoint #${seq}?`
  const paths = [...plan.write, ...plan.delete]
  if (paths.length === 0) return { title, body: 'Nothing to change: the worktree already matches this checkpoint.' }
  const shown = paths.slice(0, 8).join(', ')
  const rest = paths.length > 8 ? ` and ${paths.length - 8} more` : ''
  const lines = [
    `Write ${plural(plan.write.length, 'file')}, delete ${plural(plan.delete.length, 'file')}.`,
    `${shown}${rest}`,
    'A return point is saved first.',
  ]
  if (working) lines.push('This session looks busy: an agent working in these files may fight the restore.')
  return { title, body: lines.join(' ') }
}
```

`apps/cockpit/src/host/cockpit-api.ts` — add `import { parseCheckpoints, parseRestorePlan, type Checkpoint, type CheckpointDiff, type RestorePlan } from '../lib/checkpoints'` with the other imports, and after `sessionDiff(...)`:

```ts
    checkpoints(idOrName: string): Promise<Checkpoint[]> {
      return invoke('checkpoint.list', { idOrName }).then(parseCheckpoints)
    },
    takeCheckpoint(idOrName: string): Promise<unknown> {
      return invoke('checkpoint.take', { idOrName })
    },
    checkpointDiff(idOrName: string, from: number, to?: number): Promise<CheckpointDiff> {
      return invoke('checkpoint.diff', { idOrName, from, ...(to === undefined ? {} : { to }) })
    },
    /** A dry run: what restoring would write and delete. Nothing changes. */
    previewRestore(idOrName: string, seq: number): Promise<RestorePlan> {
      return invoke('checkpoint.restore', { idOrName, seq }).then(parseRestorePlan)
    },
    /** The real thing, only ever sent after the person confirmed the preview. */
    restoreCheckpoint(idOrName: string, seq: number, force: boolean): Promise<unknown> {
      return invoke('checkpoint.restore', { idOrName, seq, apply: true, force })
    },
```

`apps/cockpit/src/ui/CheckpointsDialog.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'preact/hooks'
import { describeRestore, type Checkpoint, type CheckpointDiff, type RestorePlan } from '../lib/checkpoints'
import { patchSections } from '../lib/patch'
import { plainErrorMessage } from '../lib/cockpit-host'
import { relativeTime } from '../lib/rail'
import type { ConfirmRequest } from './ConfirmDialog'

const STATUS_MARK = { added: 'A', modified: 'M', deleted: 'D' } as const

/** The rows alone — pure, so it is walk-tested; the dialog below owns the state and the calls. */
export function CheckpointList({ rows, now, onTurn, onSince, onRestore }: {
  rows: readonly Checkpoint[]
  now: number
  onTurn: (seq: number) => void
  onSince: (seq: number) => void
  onRestore: (seq: number) => void
}) {
  if (rows.length === 0) {
    return <p class="cockpit-placeholder">No checkpoints yet — one is taken when an agent finishes a turn, or press Checkpoint now.</p>
  }
  return (
    <ul class="cockpit-checkpoints__list" aria-label="Checkpoints, newest first">
      {rows.map((c, i) => {
        const ago = relativeTime(c.at, now)
        const oldest = i === rows.length - 1
        return (
          <li key={c.seq} class="cockpit-checkpoints__row">
            <span class="cockpit-checkpoints__seq">#{c.seq}</span>
            <span class="cockpit-muted">{c.kind}</span>
            {c.label !== undefined ? <span>{c.label}</span> : null}
            <span class="cockpit-changes__count">+{c.files.added} ~{c.files.modified} −{c.files.deleted}</span>
            {ago !== undefined ? <span class="cockpit-muted">{ago}</span> : null}
            <span class="cockpit-checkpoints__actions">
              <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={oldest}
                title={oldest ? 'The oldest checkpoint has no earlier one to compare with' : 'What changed between the previous checkpoint and this one'}
                onClick={() => onTurn(c.seq)}>This turn</button>
              <button type="button" class="cockpit-btn cockpit-btn--sm" title="What changed since this checkpoint, up to now" onClick={() => onSince(c.seq)}>Since</button>
              <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--danger" onClick={() => onRestore(c.seq)}>Restore…</button>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

type Shown = { title: string; diff: CheckpointDiff } | { error: string } | undefined

export function CheckpointsDialog({ sessionName, working, revision, load, take, loadDiff, preview, restore, askConfirm, onToast, onClose }: {
  sessionName: string
  /** The session looks busy (inferred): the confirmation says so. */
  working: boolean
  /** Changes whenever the session list does, so the rows refresh after a turn ends. */
  revision: number
  load: () => Promise<Checkpoint[]>
  take: () => Promise<unknown>
  loadDiff: (from: number, to?: number) => Promise<CheckpointDiff>
  preview: (seq: number) => Promise<RestorePlan>
  restore: (seq: number, force: boolean) => Promise<unknown>
  askConfirm: (request: ConfirmRequest) => Promise<boolean>
  onToast: (message: string, kind: 'info' | 'error') => void
  onClose: () => void
}) {
  const [rows, setRows] = useState<Checkpoint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState<Shown>(undefined)
  const [busy, setBusy] = useState(false)

  const reload = (): void => {
    load().then((next) => { setRows(next); setError(null) }, (err: unknown) => setError(plainErrorMessage(err)))
  }
  // `load` is a fresh closure on every render; the revision is what decides a refetch.
  useEffect(reload, [revision])

  const show = (title: string, from: number, to?: number): void => {
    setShown(undefined)
    loadDiff(from, to).then((diff) => setShown({ title, diff }), (err: unknown) => setShown({ error: plainErrorMessage(err) }))
  }

  const takeNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const out = (await take()) as { unchanged?: boolean } | null
      onToast(out?.unchanged === true ? 'Nothing changed since the last checkpoint' : 'Checkpoint taken', 'info')
      reload()
    } catch (err) { onToast(plainErrorMessage(err), 'error') } finally { setBusy(false) }
  }

  const restoreAsk = async (seq: number): Promise<void> => {
    setBusy(true)
    try {
      const plan = await preview(seq)
      const words = describeRestore(seq, plan, working)
      const empty = plan.write.length + plan.delete.length === 0
      if (empty) { onToast(words.body, 'info'); return }
      if (!(await askConfirm({ title: words.title, body: words.body, confirmLabel: 'Restore', danger: true }))) return
      await restore(seq, working)
      onToast(`Restored checkpoint #${seq}`, 'info')
      reload()
    } catch (err) { onToast(plainErrorMessage(err), 'error') } finally { setBusy(false) }
  }

  const sections = useMemo(() => (shown !== undefined && 'diff' in shown ? patchSections(shown.diff.patch) : []), [shown])

  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div class="cockpit-picker cockpit-checkpoints" role="dialog" aria-label={`Checkpoints for ${sessionName}`}
        onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => { if (ev.code === 'Escape') onClose() }}>
        <h2 class="cockpit-picker__title">Checkpoints — {sessionName}</h2>
        {error !== null ? <p class="cockpit-error" role="alert">{error}</p> : null}
        <CheckpointList rows={rows} now={Date.now()} onTurn={(seq) => {
          const i = rows.findIndex((r) => r.seq === seq)
          const before = rows[i + 1]
          if (before !== undefined) show(`#${before.seq} → #${seq}`, before.seq, seq)
        }} onSince={(seq) => show(`#${seq} → now`, seq)} onRestore={(seq) => { void restoreAsk(seq) }} />
        {shown !== undefined && 'error' in shown ? <p class="cockpit-error" role="alert">{shown.error}</p> : null}
        {shown !== undefined && 'diff' in shown ? (
          <div class="cockpit-changes__patch">
            <h3 class="cockpit-changes__file">{shown.title} · {shown.diff.files.length} file{shown.diff.files.length === 1 ? '' : 's'}</h3>
            <ul class="cockpit-changes__files">
              {shown.diff.files.map((f) => (
                <li key={f.path}>
                  <span class={`cockpit-changes__mark is-${f.status}`}>{STATUS_MARK[f.status]}</span>
                  <span class="cockpit-changes__path">{f.path}</span>
                  <span class="cockpit-changes__count">+{f.added} −{f.deleted}</span>
                </li>
              ))}
            </ul>
            {sections.map((section) => (
              <div key={section.path}>
                <h3 class="cockpit-changes__file">{section.path}</h3>
                {section.lines.map((line, i) => <div key={i} class={`cockpit-diff-line is-${line.kind}`}>{line.text}</div>)}
              </div>
            ))}
            {shown.diff.truncated ? <p class="cockpit-muted cockpit-changes__note">The diff is longer than shown — `cw checkpoint diff` prints the rest.</p> : null}
          </div>
        ) : null}
        <div class="cockpit-picker__actions">
          <button type="button" class="cockpit-btn" disabled={busy} onClick={() => { void takeNow() }}>Checkpoint now</button>
          <button type="button" class="cockpit-btn cockpit-btn--primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
```

`apps/cockpit/src/ui/Sidebar.tsx` — extend the union and add the menu item right after "Run checks":

```ts
export type RowAction = 'open' | 'stop' | 'changes' | 'debug' | 'land' | 'kill' | 'delete' | 'terminal' | 'check' | 'compare' | 'checkpoints'
```
```tsx
              <button type="button" role="menuitem" onClick={() => rowMenu('checkpoints')}>Checkpoints…</button>
```

`apps/cockpit/src/ui/ProjectView.tsx`: import `CheckpointsDialog` (`import { CheckpointsDialog } from './CheckpointsDialog'`); add state next to `const [compare, setCompare] = ...`:

```ts
  const [checkpointsFor, setCheckpointsFor] = useState<string | null>(null)
```
in `rowAction`, before the `terminal` branch:
```ts
    else if (action === 'checkpoints') setCheckpointsFor(sessionId)
```
and next to the `CompareView` block in the JSX:

```tsx
        {visible && checkpointsFor !== null && sessionById(checkpointsFor) !== undefined ? (
          <CheckpointsDialog
            sessionName={sessionById(checkpointsFor)!.name}
            working={sessionById(checkpointsFor)!.activity === 'working'}
            revision={sessionsRevision}
            load={() => api.checkpoints(checkpointsFor)}
            take={() => api.takeCheckpoint(checkpointsFor)}
            loadDiff={(from, to) => api.checkpointDiff(checkpointsFor, from, to)}
            preview={(seq) => api.previewRestore(checkpointsFor, seq)}
            restore={(seq, force) => api.restoreCheckpoint(checkpointsFor, seq, force)}
            askConfirm={(request) => hostRef.current.askConfirm(request)}
            onToast={(message, kind) => hostRef.current.toast(message, kind)}
            onClose={() => setCheckpointsFor(null)}
          />
        ) : null}
```
(`sessionById` and `sessionsRevision` already exist in this file — `handleCheck` and the `CompareView` props use them. If `ListedSession` names its status field differently from `activity`, use the field `rowState` reads in `src/lib/rail.ts`.)

`apps/cockpit/src/ui/app.css` — append (tokens already defined; no literal colours, which `tokens.test.ts` enforces):

```css
.cockpit-checkpoints {
  width: calc(var(--cw-row-h) * 40);
  max-width: 100%;
  max-height: calc(100vh - var(--cw-space-4) * 2);
  overflow: auto;
}

.cockpit-checkpoints__list { list-style: none; margin: 0; padding: 0; }

.cockpit-checkpoints__row {
  display: flex;
  align-items: center;
  gap: var(--cw-space-3);
  padding: var(--cw-space-2) 0;
}

.cockpit-checkpoints__actions { margin-left: auto; display: flex; gap: var(--cw-space-2); }
```

- [ ] **Step 4: Run to verify it passes** — one gate at a time:

Run: `cd apps/cockpit && bun test tests/checkpoints.test.tsx tests/channels.test.ts tests/tokens.test.ts --max-concurrency=1`, then `bun test --max-concurrency=1`, then `bun run build`.
Expected: PASS and a clean build. Then look at the real app: `bun node_modules/electron/install.js` once if `dist` is empty, start it with an isolated profile (`--user-data-dir <scratch>`, per the project memory, so the installed app does not take the project), open the row menu → Checkpoints…, take one, change a file in the session's worktree, take another, open "This turn", press Restore…, confirm, and read the computed styles/screenshot over CDP (`apps/cockpit/scripts/` patterns). Stop the scratch daemon afterwards (`lsof -a -d cwd -c bun | grep <scratch>`).

- [ ] **Step 5: Stage and propose** — `git add apps/cockpit`; message `feat(cockpit): a Checkpoints dialog to diff a turn and restore it`.

---

### Task 8: Debt record, measurements, full gate

**Files:**
- Create: `docs/superpowers/specs/2026-10-10-session-checkpoints-known-limitations.md`
- Modify: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md` (one line)

- [ ] **Step 1: Measure.** Create a throwaway script outside the repo (`$TMPDIR/measure-checkpoint.ts`), importing `takeCheckpoint` by absolute path, run it with `bun` against a scratch worktree of this repository, and record real numbers (first take, an incremental take after editing one file, a take after adding 100 small files, daemon-side peak RSS via `process.memoryUsage().rss` before/after, bytes added under `.git/objects` per checkpoint via `git count-objects -vH`):

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeCheckpoint } from '/Users/nmh/work/Mac/NMHx/Personal/crossweave/src/domain/checkpoint.ts';

const repo = '/Users/nmh/work/Mac/NMHx/Personal/crossweave';
const scratch = mkdtempSync(join(tmpdir(), 'cw-measure-'));
const wt = join(scratch, 'wt');
execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: repo });
const ctx = { projectRoot: scratch, sessionId: 's_measure', worktree: wt };
const time = async (label: string, fn: () => Promise<unknown>) => {
  const t0 = performance.now(); await fn();
  console.log(label, `${Math.round(performance.now() - t0)} ms`, `rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
};
await time('first take', () => takeCheckpoint(ctx, 'baseline'));
writeFileSync(join(wt, 'README.md'), 'edited\n');
await time('incremental (1 file)', () => takeCheckpoint(ctx, 'turn'));
for (let i = 0; i < 100; i += 1) writeFileSync(join(wt, `scratch-${i}.txt`), `${i}\n`);
await time('incremental (100 new files)', () => takeCheckpoint(ctx, 'turn'));
console.log(execFileSync('git', ['count-objects', '-vH'], { cwd: repo, encoding: 'utf8' }));
console.log('cleanup: git worktree remove --force', wt, '(then delete refs/crossweave/checkpoints/s_measure and the scratch dir by hand)');
```
Then remove the scratch worktree with `git worktree remove --force <wt>` and move the scratch directory to `~/.Trash` (never `rm -rf`), and delete the measurement refs: `git for-each-ref --format='%(refname)' refs/crossweave | xargs -n1 git update-ref -d`.

- [ ] **Step 2: Write the known-limitations file** — `docs/superpowers/specs/2026-10-10-session-checkpoints-known-limitations.md`, same style as the sibling files (a heading, then one bullet per limit, each with *why* and *what would change it*). Required bullets, with the measured numbers from Step 1 filled in: ignored files not captured or restored; shared/plain sessions have none; a plain shell never reaches `working` so gets only manual checkpoints (and a `baseline` is only taken when a recognised agent starts working); the turn end is a heuristic; 20-checkpoint cap, not configurable; the 50 MB untracked guard (tracked changes are not counted); the real index is not touched, so staged state may disagree with restored files; a secret in a non-ignored file lives in `.git` objects (local, never in default push refspecs); objects persist until git gc; restoring while HEAD moved shows the difference as uncommitted changes; a path that changes type between file and directory is restored but not specially handled; no rail chip, no ledger event for take/restore; the dialog reads the session list's `activity` for the busy warning; `cw checkpoint diff` cuts the patch at 512 KB; the timing/memory/disk numbers measured in Step 1; the cockpit dialog was checked live (say what was and was not).

- [ ] **Step 3: Add the digest line** — append to `docs/superpowers/specs/2026-08-14-known-limitations-digest.md` (match its bullet style):

```
- `2026-10-10-session-checkpoints-known-limitations.md` — hidden git commits (`refs/crossweave/checkpoints/<session>/<n>`, orphan, from a private index) taken when an agent turn ends (+ a baseline on first work, + manual); `checkpoint.list|take|diff|restore`, `cw checkpoint`, a cockpit dialog. Restore is dry-run by default, saves a pre-restore checkpoint, moves no HEAD/branch/real index. Ignored files out of scope; plain shells get manual checkpoints only; turn end is inferred; 20 kept; 50 MB untracked guard; no schema change
```

- [ ] **Step 4: Run the full gate, sequentially** (note the concurrency used in the report):

1. `bun run typecheck`
2. `bun test --max-concurrency=1` — files needing a pty or a unix-socket bind fail with `Failed to open PTY` / `EPERM` inside a restricted shell; run those outside the sandbox, and compare any red against `main` before blaming this branch (`AGENTS.md`).
3. `bun run build`
4. `cd apps/cockpit && bun test --max-concurrency=1 && bun run build`

Report each result as green, red or **unfinished** (with the reason). Never report an unfinished gate as green.

- [ ] **Step 5: Stage and propose** — `git add docs src apps tests`; show `git status` and `git diff --stat`; message `docs: record session checkpoints and their known limitations`. Ask the owner whether to commit (one commit per task, as proposed above) and whether to merge to `main` (fast-forward only).

---

## Self-Review

**Spec coverage:** Mechanism (private index, orphan commits, subject metadata, retention 20, 50 MB guard, per-session lock, own-worktree only) → Tasks 2–3. Turn trigger and baseline → Task 5 (`checkpointKindFor`, `onChange`, `autoCheckpoint`). Restore (dry-run default, pre-restore, validate-then-delete-then-write, no HEAD/index move, busy refusal + force) → Task 3 (domain) and Task 5 (busy). Cleanup (rm/kill/gc/land + orphan prune) → Task 4. RPC table and error codes → Task 5. CLI → Task 6. Cockpit dialog, menu entry, channels, parser → Task 7. Security items (assertContained, execFile args, no shell, symlink test, secrets limitation) → Tasks 3 and 8. Testing list → each task. Measuring before claiming → Task 8. Known limitations → Task 8.

**Placeholder scan:** none left; every code step carries code. Two explicit conditional notes name the exact file to check (`methods-plain.test.ts`, `src/lib/rail.ts`) because they depend on code the plan author could not see change.

**Type consistency:** `CheckpointContext`, `CheckpointInfo`, `snapshot`, `takeCheckpoint`, `listCheckpoints`, `diffCheckpoints`, `restoreCheckpoint`, `deleteSessionCheckpoints`, `pruneOrphans`, `changesBetween`, `TreeDiff`, `RestorePlan` are named identically in Tasks 2–5 and 7; the RPC reply shapes (`{checkpoints}`, `{unchanged, seq}`, `{plan, applied, preRestoreSeq}`) match between Task 5, Task 6 and Task 7's parsers.

**Spec deltas made while planning (told to the owner):** the `baseline` kind and its trigger; delete-before-write and `checkout-index -f -- <paths>` instead of `-a`; the symlink behaviour reworded; the parser lives in `src/lib/checkpoints.ts`.
