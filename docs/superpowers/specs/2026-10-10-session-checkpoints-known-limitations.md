# Session checkpoints — known limitations

Spec: `2026-10-10-session-checkpoints-design.md`. Plan: `docs/superpowers/plans/2026-10-10-session-checkpoints.md` (with the
amendments from its adversarial review).

## What shipped

Hidden snapshots of a session's worktree: an orphan git commit per checkpoint under
`refs/crossweave/checkpoints/<sessionId>/<seq>`, built from a private index (`.crossweave/checkpoint-index/<sessionId>`), so the
branch, the real index and the working tree are never touched. They are taken when a recognised agent **starts** (`start`) and
**finishes** (`turn`) a turn, on demand (`manual`), and before every restore (`pre-restore`). `checkpoint.list|take|diff|restore`
RPCs, `cw checkpoint list|take|diff|restore`, and a cockpit **Checkpoints…** row-menu dialog (list, This turn, Since, Restore…).
Restore is a dry run unless `apply`, saves a return point first, moves no HEAD, branch or index, and refuses (before changing
anything) when it would destroy an ignored file or write through a symlink. No schema change (still v18).

Measured on this repository (662 tracked files, Bun 1.3.14, git 2.54, `$TMPDIR` worktree, cold OS cache not controlled):
first take 139 ms, take after editing one file 141 ms, take with nothing changed 94 ms (it still hashes: the dedupe saves the
object, not the walk), take after adding 100 files 155 ms, `list` 12 ms, restore preview 46 ms, applying a restore that deletes
100 files 126 ms; daemon-side RSS grew from 44 to 54 MB over the whole sequence; three checkpoints plus 100 small files added 107
loose objects (~430 KB). Larger repositories were **not** measured — `git add -A` against a warm private index is incremental,
but a cold first take is a full hash of the worktree. Verified live on the real cockpit with
`apps/cockpit/scripts/checkpoints-check.ts` (8 checks: menu entry, list, Checkpoint now, This turn diff, Restore… confirmation
text, nothing written before the answer, file back on disk) and through the real `cw` binary and daemon (take, list, diff,
preview, apply, undo, from the project root and from inside a session shell).

## Limitations

- **Ignored files are neither captured nor restored** (`.env`, `node_modules`, build output). A restore will refuse
  (`CHECKPOINT_RESTORE_BLOCKED`) rather than delete an ignored file that stands where the checkpoint needs a directory, or a
  directory of ignored files where it needs a file; the person moves it aside and retries.
- **Only sessions with a worktree of their own, and only with a recognised agent, get automatic checkpoints.** A session in the
  project folder has none (`CHECKPOINT_NO_WORKTREE`); a plain shell reaches `working` on any output (an `ls`, a dev server's
  logs), which is not a turn, so it gets manual checkpoints only.
- **Turn boundaries are inferred.** They follow `session-status.ts`, which reads an agent's screen. The agent can be visible to
  `ps` a sweep after the output that made the session `working`, so the `start` checkpoint is *owed* and taken at the first
  sweep where the agent shows up and the session is still working (`createAutoCheckpointer.poll`). When the busy screen appears
  after the agent launches, the first `working → asked` can take a `turn` checkpoint with nothing new in it, and the `start` one
  is then deduped away because the tree is the same — the pair still brackets the turn.
- **A pane-only agent is not announced.** `ActivityTracker.sweep` only reports sessions that have their own shell track
  (the existing "sweep cannot announce a track-less session moved by its pane" limit), so an agent run only in a split pane of a
  session whose own shell is closed gets no automatic checkpoints.
- **50 checkpoints per session** (two per turn, so about 25 turns), a constant, not a setting. Older ones are deleted; their
  objects stay until git's own gc.
- **The 50 MB untracked-content guard covers automatic checkpoints only** (a person's `manual` one and the `pre-restore` one skip
  it so a restore is possible exactly when an agent misbehaved). Tracked changes are not counted by the guard. The error names the
  three largest files.
- **The real index is left alone.** After a restore, staged state can disagree with the restored files.
- **If the agent committed during the turn, restoring an older checkpoint shows as an uncommitted diff against those commits.**
  Nothing is lost (the commits stay), but `git status` will list the difference.
- **The applied restore can differ from the previewed one** if files change between the preview and the confirmation. It is
  re-validated and re-planned at apply time, but the person is not asked again.
- **A secret in a file that is not gitignored lives in the repository's object store** inside a checkpoint. The refs are not
  under `refs/heads` or `refs/tags`, so default push refspecs never publish them, but `git push --mirror` would, and
  `git log --all` and graph views show up to 50 orphan commits per session titled `checkpoint …`.
- **Refs are shared by every worktree of a repository.** `gc` therefore prunes only sessions this project has a private index for;
  refs whose index file was lost are never pruned.
- **`checkpoint.diff` runs `git diff` synchronously on the daemon's event loop** (the same as `session.diff`); the patch is cut at
  512 KB. Ref deletion is one `update-ref` per ref.
- **A path that changes type between a file and a directory** is restored (deletes first, then writes) but has only the tests
  listed in the spec, not a dedicated one for every nesting.
- **No rail chip and no ledger event.** The dialog is the only surface; taking or restoring a checkpoint is not recorded in the
  event ledger or the journal. A cockpit that is too old to know the four new channels cannot open the dialog (a daemon that is
  too old answers `unknown method`).
- **Why this when agents have an undo:** an agent's rewind covers only that agent's own edits; a checkpoint also covers what shell
  commands and the person changed, and it is agent-agnostic.

## Ideas not built

Diff comments sent back to the shell (feature 2 of this series), auto-running the session check at turn end (3), and a
sensitive-file flag in the diff (4) are separate milestones; checkpoints are their foundation (the "since the last turn" diff).
