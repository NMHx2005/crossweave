A **session** is a git worktree on its own branch plus your shell in it, like a tmux window with a branch of its own. What runs in the shell is yours to type: `claude`, `codex`, a wrapper of yours, a dev server. crossweave does not choose or configure an agent; a launcher you pick types its saved command into the shell and runs it.

## The rail

The Cockpit lists every project and its sessions on one rail. A row says what the session is doing: a turning ring while an agent works, a ✓ when one finished and you have not looked yet, amber when it asks you something, nothing for a shell with nothing running. These marks are inferred from the shell (screen words, output, the bell and the process tree), so they are reliable for Claude Code, Codex and Gemini and approximate for others. `cw hooks install claude` (or `codex`) wires that agent's own hooks to `cw notify`, which makes the marks exact where the agent reports them.

## Isolation

Each session gets its own port block (`$PORT`), cache directory and optional database or Docker names. These are cooperative: they are injected into the session's environment, and a process that ignores them can still collide with another session.

## Landing and evidence

A background daemon trial-merges sessions against the base branch and against each other. `cw land` is gated on that evidence, which is valid only against the base commit it was trialled on: after one session lands, the others read *unknown* until they are trialled again. `cw converge status` says why. An optional setting, `converge.requireCheck`, also refuses to land a session without a fresh passing check.

## Checks

`cw check` runs the project's trusted test command in a session's own worktree and shows the verdict on the rail. A command that comes from a repository must be trusted once with `cw config trust`; commands you wrote yourself, such as presets and launchers, need no such step. In the Cockpit you can opt in to running the check automatically when an agent ends a turn that changed files; that is off by default, and because the end of a turn is inferred a run can be missed or repeated.

## Checkpoints

When a recognised agent starts and finishes a turn in a session that has its own worktree, crossweave records the worktree as a hidden git commit (`refs/crossweave/checkpoints/<session>/<n>`). `cw checkpoint list`, `diff` and `restore` read and use them. A restore is a dry run unless you say otherwise. Applying it saves a return point first, then writes and deletes non-ignored files to match the checkpoint, and it refuses before touching anything if that would overwrite an ignored file or write through a symlink. Checkpoints skip ignored files, can be skipped when a snapshot is too large, are visible to `git log --all` and `git push --mirror`, and include non-ignored files such as secrets. The newest 50 are kept.

## Overlap

`cw overlap` and the rail show other sessions touching the same files, early, before a trial merge conflicts. It is a signal that advises and never blocks.
