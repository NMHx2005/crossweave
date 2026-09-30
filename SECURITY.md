# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository (<https://github.com/NMHx2005/crossweave/security/advisories/new>).
Include what you saw, the version (`cw --version`), your OS, and the smallest steps that reproduce it. You will get an answer as soon as
the maintainer can read it; this is a small personal project, so there is no service-level promise, but a real vulnerability is taken
seriously and fixed before it is discussed publicly.

Supported version: the latest release (currently 0.4.x). Earlier versions get no fixes.

## What crossweave is, and what it is not

crossweave is a **local-first** tool. Everything runs on your machine, as you:

- `cwd` (the daemon) owns `.crossweave/state.db` and listens **only on a unix-domain socket** inside your repository's `.crossweave/`
  directory. It opens **no network port**. (The browser remote control that once did was removed; see `docs/PROGRESS.md`.)
- A session is a git worktree plus **your own shell** in it. crossweave does not pick, configure or sandbox what you run there: a
  process in a session has all your permissions. Per-session ports, caches and database names are **cooperative** — they are injected as
  environment variables, and a process that ignores them can still collide. They are not a security boundary, and the OS sandbox that
  once existed was removed (tag `v0.3-radar`).
- crossweave does not send your code anywhere. Updates are checked against GitHub Releases in the background (cached, at most once a day;
  turn it off with `cw config update-check off`) and never installed without you running `cw update`.

## Trust model — what is and is not treated as hostile

| Input | Treated as | What crossweave does about it |
|---|---|---|
| A repository's `crossweave.config.json` (`converge.testCommand`, hooks) | **Untrusted until you say so** — it arrives from a clone | Never run until `cw config trust`; editing the command or hooks re-locks it. `cw check` and `land` use the same gate |
| Your `~/.crossweave/settings.json` (launchers, presets, the composer's refine command) | **Yours** | Run for you as written; validated as one plain line, no shell (argv). A repository cannot add or change them |
| Anything that can reach the daemon's unix socket | **Same-user, unauthenticated** (a process running as you) | The command bridge (`cw pane`, `cw browser`) and `cw notify` are closed lists of kinds; every decision is taken in the cockpit (or the daemon), never trusted from the caller; anything beyond arranging panes or showing a mark asks you first. A same-user process that registers on the bridge first can answer or forge output — this is a stated limit, not a bug we can close without authenticating callers |
| Text a web page wrote (console, network, `dom`, `eval` results, screenshots) | **Untrusted data** — it can carry instructions aimed at an agent | Marked `"untrusted": true`; the per-pane **Agent** switch is off by default. Screenshots, `dom` and `eval` results are **not** redacted |
| A prompt you send with the composer | Text, never keystrokes | Control characters (an escape that could end a bracketed paste early) are stripped; a plain shell is never sent more than one line |
| Paths from a session's output, file drops, `cw pane open --file` | Untrusted paths | Resolved and contained inside the session's worktree (`assertContained`, symlink by symlink) |

## Things that are deliberately out of scope

- Another program running as your user (it can already do everything crossweave can).
- A malicious agent you chose to run in a session (it has your shell). Review what you let an agent do, exactly as you would without crossweave.
- The app is signed with a development certificate and is **not notarized**; macOS may ask you to allow it on first launch.

Each feature's remaining gaps are written down next to its design in `docs/superpowers/specs/*-known-limitations.md`; the one-line
versions are in `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`.
