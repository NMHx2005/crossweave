A **session** is a git worktree on its own branch plus your shell in it, like a tmux window with a branch of its own. What runs in the shell is yours to type: `claude`, `codex`, a wrapper of yours, a dev server. crossweave never chooses, configures or launches an agent for you.

## The rail

The Cockpit lists every project and its sessions on one rail. A row says what the session is doing: a turning ring while an agent works, a ✓ when one finished and you have not looked yet, amber when it asks you something, nothing for a shell with nothing running. These marks are inferred from the shell (screen words, output, the bell and the process tree), so they are reliable for Claude Code, Codex and Gemini and approximate for others. `cw hooks install` wires an agent's own hooks to `cw notify`, which makes the marks exact.

## Isolation

Each session gets its own port block (`$PORT`), cache directory and optional database or Docker names. These are cooperative: they are injected into the session's environment, and a process that ignores them can still collide with another session.

## Landing and evidence

A background daemon trial-merges sessions against the base branch and against each other. `cw land` is gated on that evidence, which is valid only against the base commit it was trialled on: after one session lands, the others read *unknown* until they are trialled again. `cw converge status` says why. An optional setting, `converge.requireCheck`, also refuses to land a session without a fresh passing check.

## Checks

`cw check` runs the project's trusted test command in a session's own worktree and shows the verdict on the rail. A command that comes from a repository must be trusted once with `cw config trust`; commands you wrote yourself, such as presets and launchers, need no such step. In the Cockpit you can opt in to running the check automatically when an agent ends a turn that changed files; that is off by default.

## Checkpoints

When a recognised agent starts and finishes a turn in a session that has its own worktree, crossweave records the worktree as a hidden git commit (`refs/crossweave/checkpoints/<session>/<n>`). `cw checkpoint list`, `diff` and `restore` read and use them. A restore is a dry run unless you say otherwise, saves a return point first, and refuses before it would destroy anything. The newest 50 are kept.

## Overlap

`cw overlap` and the rail show other sessions touching the same files, early, before a trial merge conflicts. It is a signal that advises and never blocks.
