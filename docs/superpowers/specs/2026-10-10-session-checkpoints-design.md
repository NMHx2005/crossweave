# Session checkpoints — snapshot each AI turn, diff it, take it back

**Date:** 2026-10-10
**Status:** Draft for review (part 1 — mechanism — approved in chat 2026-10-10; part 2 — surfaces, errors, tests — new here)
**Branch:** `feat/checkpoints` (first of four: checkpoints → diff comments → auto-check → sensitive-file flags)

## Why

The person lets an agent run unattended in a session's worktree. Agents often leave their work **uncommitted**, so
the usual safety net — `git` history — has nothing to go back to when a turn goes wrong, and `session.diff` (committed
work since the base) cannot even show what the last turn did. Two things are missing:

1. **What did the agent just change?** — the diff of one turn, not of the whole branch.
2. **Put it back.** — undo one turn without hand-picking files out of `git status`.

Success looks like: after a bad turn, one command or one click shows the turn's diff and restores the files, and the
restore itself can be undone.

## Why this, when agents have their own undo

An agent's rewind covers only that agent's own edits. A checkpoint is agent-agnostic (the person types any command in the
shell), also captures what shell commands and the person's own edits changed, and gives a per-turn diff across agents.

## Non-goals

- Not a backup of ignored files (`.env`, `node_modules`, build output) — they are neither captured nor restored.
- Not a replacement for commits: no branch, index or HEAD is moved, ever.
- No agent knowledge: "a turn ended" is whatever the existing status inference says (`working` → `idle`/`asked`).
- No new settings, no schema change (`SCHEMA_VERSION` stays 18), no new dependency, no native module.

## Mechanism

A checkpoint is a **hidden git commit** whose tree is the worktree's content (tracked + untracked, minus ignored),
stored under `refs/crossweave/checkpoints/<sessionId>/<seq>` (`seq` zero-padded to 6 digits so refs sort).

- **Taking one**, without touching the real index, branch or working tree:
  1. a **private index** file at `.crossweave/checkpoint-index/<sessionId>` (seeded once with `git read-tree HEAD`);
     it keeps git's stat cache, so after the first run `git add -A` only re-hashes what changed;
  2. `GIT_INDEX_FILE=<private> git add -A` (honours `.gitignore`), then `git write-tree`;
  3. if the tree equals the newest checkpoint's tree, **stop** — no ref, no new object (a mis-guessed turn end costs a
     comparison);
  4. else `git commit-tree <tree> -m <message>` with a fixed author/committer (`crossweave <crossweave@localhost>`, so no
     user git config is needed) and `git update-ref` to the next `seq`.
- **No parent.** A checkpoint is an orphan commit. A parent chain would keep every pruned checkpoint reachable through the
  newest one and make pruning free nothing. A turn's diff is `git diff <tree(n-1)> <tree(n)>`, which needs no ancestry.
- **Message** (one `git for-each-ref` reads the lot, no database): a single line `checkpoint <kind> head=<sha> at=<ms> files=<a>,<m>,<d> [label=<text>]`. `kind` is `start` | `turn` | `manual` | `pre-restore`; `files=<added>,<modified>,<deleted>` (against the previous checkpoint, or against its own HEAD for the first) is stored too, so listing is one `for-each-ref` and never re-diffs.
- **Retention:** newest **50** per session — two per turn (start and end) — (a constant, not a setting — a new contract is not worth a knob yet); the
  rest are `update-ref -d`'d after every take. Objects are collected by git's own gc.
- **Size guard:** before `add -A`, the untracked-and-not-ignored content (`git ls-files -o --exclude-standard`) is summed;
  over **50 MB** an *automatic* checkpoint (`start`/`turn`) is skipped with `CHECKPOINT_TOO_LARGE`, the error naming the three largest files. A person's own `manual` checkpoint and the `pre-restore` one bypass the guard — blocking a restore exactly when an agent misbehaved would defeat the feature. An agent that writes a 2 GB file the repo does
  not ignore must not fill the disk through us.
- **Serialisation:** one promise chain per session serialises take, restore and prune, so two takes never interleave and
  a restore never runs under a take. The private index also avoids contending for the real `index.lock`.
- **Who gets checkpoints:** sessions with their **own worktree** (`isCrossweaveWorktree`). A session in the project folder
  (shared/plain) has none: its "worktree" is the user's own checkout — `CHECKPOINT_NO_WORKTREE`.

### When a turn starts and ends

`ActivityTracker.sweep` returns only the ids whose activity changed, not from-what-to-what. It gains an optional public
`onChange(id, from, to)` listener, called inside `sweep` where `t.reported` is updated; `sweep`'s return value and its
callers are unchanged. In `buildMethods` the listener feeds `checkpointKindFor(from, to)`: `→ working` is a **`start`**
checkpoint, `working → idle|asked` is a **`turn`** one (`failed` takes nothing). Both are fire-and-forget, errors are
logged to `daemon.log` and never thrown into the sweep, and both are taken **only when a recognised agent runs in the
session** (`agentForRow`): without that gate every `ls`, or a dev-server log burst in a split pane, would count as a turn.

Two checkpoints per turn is deliberate. The `start` one captures the person's own edits made *between* turns, so "undo that
turn" never reverts them; the dedupe rule makes it free when nothing changed since the previous `turn`.

**Honest limit:** a plain shell (no recognised agent) gets no automatic checkpoints, only manual ones. A session without a
worktree of its own is skipped silently.

### Restoring

`restore(seq)`:

1. refuse a `working` session unless `force` (`CHECKPOINT_SESSION_BUSY`) — the status is a guess, so the escape hatch is
   explicit;
2. take a **`pre-restore`** checkpoint of the current state; if the tree equals the newest checkpoint's, that checkpoint
   already is the return point and its `seq` is reported as `preRestoreSeq` (the dedupe rule above, not an exception to
   it) — either way a restore is itself undoable;
3. compute the **plan** from the two trees: `write` = paths whose content differs or are absent in the worktree,
   `delete` = paths present now (non-ignored) but absent in the target;
4. if `apply` is not set, return the plan and stop (**dry-run is the default**);
5. else, **validating before touching anything** (git paths never contain `..`, but this is the only gate, so it is
   checked): every leading directory of every path to write or delete must be absent, a real directory, or itself about to
   be deleted — never a **symlink** (a write would go through it) and never an **ignored file** (git would destroy it to
   make room); a directory sitting where the checkpoint has a file may go only if it is empty (otherwise git would delete
   the ignored files inside it). Any violation aborts with `CHECKPOINT_RESTORE_BLOCKED`, naming the path, before a single
   change. Then: `unlink` the deletes first (lexically joined to the worktree and never followed, so a symlink is removed
   and its target is never touched; deleting first also lets a file become a directory), then `read-tree <target>` +
   `git checkout-index -f -- <paths>` for the writes only, both through a **throwaway** index (the private one must keep its
   stat cache, or the next take re-hashes the whole worktree), then `rmdir` the directories that became empty.

HEAD, the branch and the **real index** are not touched: if the agent committed during the turn, those commits stay;
restoring files then shows as an uncommitted diff against them, and nothing is lost. A test pins that a directory that became a symlink is
restored as a real directory and that nothing lands outside the worktree.

### Cleanup

`deleteSessionCheckpoints(projectRoot, sessionId)` (all refs + the private index) runs, best effort, wherever a session's
worktree is removed: `domain/session.ts` (`rm`), `domain/gc.ts` (both worktree removals) and `convergence/land.ts`. `gc`
also drops checkpoint refs and private indexes whose session id is no longer in the database **and whose private index
exists in this project's `.crossweave/checkpoint-index`** — refs are shared by every worktree of a repository, so
another crossweave project on the same repository must not have its checkpoints pruned.

## Surfaces

### Module and RPC

`src/domain/checkpoint.ts` (new, git only, no daemon knowledge): `takeCheckpoint`, `listCheckpoints`, `diffCheckpoints`,
`restoreCheckpoint`, `deleteSessionCheckpoints`, `pruneOrphans`. `session-diff.ts` has its range-based diff parsing
extracted into `diffBetween(cwd, a, b, opts)` (same output type, `sessionDiff` calls it; paths are read with `-z`, so an
accented or quoted name is no longer C-escaped) so a
checkpoint diff reuses the numstat/name-status/patch/truncation code instead of copying it.

| RPC | Params | Result |
|---|---|---|
| `checkpoint.list` | `workspaceId, idOrName` | `[{ seq, kind, label?, at, head, files: {added, modified, deleted} }]`, newest first; `files` is vs the previous checkpoint |
| `checkpoint.take` | `…, label?` | the new entry, or `{ unchanged: true }` |
| `checkpoint.diff` | `…, from, to?` | `SessionDiff`-shaped; `to` omitted = the live worktree (an unreferenced `write-tree`, no ref created) |
| `checkpoint.restore` | `…, seq, apply?, force?` | `{ plan: { write[], delete[] }, applied, preRestoreSeq? }` |

All four resolve the session with the existing `sessions.resolve` and take the per-session lock. New `CrossweaveError`
codes (English copy, one `CODE: message` line on the CLI): `CHECKPOINT_NO_WORKTREE`, `CHECKPOINT_NOT_FOUND`,
`CHECKPOINT_TOO_LARGE`, `CHECKPOINT_SESSION_BUSY`, `CHECKPOINT_RESTORE_BLOCKED`, `CHECKPOINT_GIT_FAILED` (wraps git's text, secrets scrubbed as `cw debug` does).

### CLI

`cw checkpoint list|take|diff|restore [session]` — session defaults to `$CW_SESSION_ID` like `cw check`. `diff <from> [to]`
prints the patch. `restore <seq>` prints the plan and exits 0 without writing; `--apply` writes; `--force` allows a busy
session. Citty ignores unknown flags, so each command declares its args explicitly.

### Cockpit

- Row menu entry **"Checkpoints…"** (next to "Run checks" and "Compare with another…") opens `CheckpointsDialog.tsx`: a list
  (time, kind, label, `+a ~m −d`), **Checkpoint now**, and per row **Changes in this turn** (the existing patch view, as in
  `CompareView`) and **Restore…**.
- **Restore…** opens the existing `ConfirmDialog` with the plan (files to write / delete, capped list + count), a warning
  line when the session is working, and the sentence that a return point is saved first. The dialog only ever calls
  `restore` with the `apply` the person confirmed.
- Wiring: the four methods are added to `electron/channels.ts` and `src/host/cockpit-api.ts`; replies are parsed by
  `src/lib/checkpoints.ts` (the pattern of `session-history.ts`: anything malformed becomes an empty list).
- No rail chip in v1 (the dialog is the surface), no setting, so `settings-guard.ts` is unaffected.

## Security

- **Same-user socket, as everywhere:** `checkpoint.restore` rewrites files in a worktree, which any same-user process can
  already do with `rm`/`git`. It adds no authority; the guard is dry-run-by-default plus the cockpit confirm.
- **Paths:** every path written or deleted comes from a git tree and passes `assertContained` against the worktree;
  deletes `lstat` first. Git's own refusal to traverse symlinked directories is relied on and covered by a test.
- **Secrets:** a checkpoint can hold a secret the person left in a file that is **not** gitignored. It lives in the
  repository's own object store (same trust domain as the repo), under a ref namespace the default fetch/push refspecs
  never touch. Recorded as a limitation.
- Git is run with `execFile` and an argument list, never a shell string; `sessionId` comes from the database, not the request.

## Testing (real git in temp repos, no pty — runs inside the sandbox)

`tests/domain/checkpoint.test.ts`: untracked file captured; ignored file not captured nor restored; identical tree → no new
ref; `seq` increments; retention keeps 20; size guard; restore writes modified, recreates deleted, deletes added; pre-restore
checkpoint exists and restoring it undoes the restore; branch/HEAD/index untouched, including when the agent committed
mid-turn; dry-run writes nothing; busy refusal and `force`; symlink-in-worktree case; shared/plain session refused;
concurrent takes serialise; cleanup removes refs and the private index; orphan prune.
`tests/daemon/methods-checkpoint.test.ts`: RPC shapes and errors, and — through a seam on `ActivityTracker`'s listener —
that `working → idle` queues a `turn` checkpoint, `idle → working` does not, `failed` does not.
`tests/cli/checkpoint.test.ts`: argument handling, dry-run output. Cockpit: `responses` parse tests (valid and malformed),
and the dialog's plan rendering if the existing component-test pattern allows it.
Tests pin behaviour and the RPC/CLI contract, never log strings.

## Measuring before claiming

Recorded in the known-limitations file with the numbers, not asserted here: time of a first and an incremental take on
this repo (459 files) and on a larger one; peak RAM of the daemon around a take; disk added per checkpoint. Target for an
incremental take on this repo: well under a second — **a target to measure, not a promise.** Gate: `bun run typecheck`,
`bun test --max-concurrency=1`, `bun run build`, and `apps/cockpit` build plus a live look at the dialog.

## Known limitations expected (to be written at the end of the milestone)

Ignored files; shared/plain sessions; plain-shell sessions get manual checkpoints only; the turn boundaries are a heuristic;
50-checkpoint cap; the 50 MB guard (automatic checkpoints only); the applied plan can differ from the previewed one if files
change in between; checkpoints are visible to `git log --all` and graph views and would travel with `git push --mirror`;
the live diff runs synchronously on the daemon's event loop; refs whose private index was lost are never pruned; real index left as it was (staged state may not match restored files); secrets in
non-ignored files; objects persist until git gc; no rail chip; no ledger event for take/restore.
