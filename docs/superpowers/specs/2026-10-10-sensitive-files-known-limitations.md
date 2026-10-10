# Sensitive-file flags — known limitations

Spec: `2026-10-10-sensitive-files-design.md` (with its amendments). Plan: `docs/superpowers/plans/2026-10-10-sensitive-files.md` (with the
amendments from its adversarial review).

## What shipped

Files of a session's diff that deserve a closer look carry a **labelled badge** (`secret`, `automation`, `migration`, `dependency`) with the reason on hover and in
the text a screen reader gets, and each file list has **one summary line** (`3 sensitive files: 1 secret · 1 automation · 1 dependency`). The lists are the Changes
pane, the Checkpoints dialog and Compare (both sides). **Land asks first** when the session's committed work touches a `secret` or `automation` file: the question names
them (at most 8, then `and N more`), and when the failing-tests question applies as well they are **one dialog** (`Land <name> anyway?`). Cockpit only: no daemon, RPC, CLI,
schema (still v18) or dependency change; the classifier is a pure module, `src/core/sensitive-files.ts`.

- **Names and paths only.** The classifier never reads a file or a patch. One kind per path, in a fixed priority (secret → automation → migration → dependency), case-insensitive,
  at any depth. A table of 127 paths pins both directions of every rule, including what must *not* flag (`src/secrets.ts`, `docs/credentials.md`, `.env.example`, `id_rsa.pub`,
  `migrate.ts`, `Dockerfile.md`, `.envrc`).
- **Lockfiles, manifests and migrations only get a badge**: they change on almost every land, and a question that is always asked teaches people to click through.
- **A diff that cannot be read asks nothing**: `handleLand` reads the names with `session.diff` and a failure (or a session without a branch) leaves the land exactly as it was.
  A guard set before the first `await` stops a double trigger from starting two lands (or two dialogs, of which `askConfirm` abandons the first).
- Paths are repository content: in the dialog a newline, tab, control or bidi character becomes a space, and the body wraps anywhere.

Verified: the classifier table; pure walk tests for the badge, the summary and the warnings (including an RLO/newline path); the tokens test with the four new
badge-on-surface pairs; and live on the real cockpit with `apps/cockpit/scripts/sensitive-files-check.ts` (15 checks: the three badges, no badge on an ordinary file, the summary line,
the reason as screen-reader text, Land becoming available, the dialog naming the env file and the workflow but **not** `package.json`, Cancel leaving the session unlanded).

## Limitations

- **Names only: it can miss and it can over-flag.** A key pasted into `config.txt` is not flagged; a harmless file named like a sensitive one is. The label says "sensitive", never
  "safe", and the question is a convenience, not a gate. Scanning the added lines for token shapes (with `redactSecrets`) is the natural next step, and is prone to false positives.
- **Ignored files never appear in a diff**, so a real (gitignored) env file is invisible here by design; the flags catch what was committed or checkpointed.
- **The patterns are a constant.** No per-project list, no allow-list, no monorepo-specific rules. Left out on purpose because they churn or run nothing: `Makefile`, `Procfile`,
  `.github/dependabot.yml`, and agent-instruction files (`CLAUDE.md`, `AGENTS.md`), which an agent can edit to change how the next one behaves.
- **A new dependency or a changed script in `package.json` does not ask**, only badges (asking would need the patch content, which this feature does not read). The reason text warns that a
  manifest can change install and test scripts.
- **Only the Land button asks.** `Land all ready`, `cw land` and a land from another client do not (the last two never saw the cockpit; `Land all ready` does not ask about failing tests either).
- **The question can be skipped, by accident or on purpose:** the daemon's `git diff` has a 64 MB buffer, so a text diff over it throws and Land proceeds unasked; every Land fetches the whole
  patch (up to 512 KB) just to read file names, because the RPC does not expose the `patch: false` option the daemon uses internally.
- **Time of check ≠ time of land.** The names are read when the dialog opens; the branch tip can still move before the merge.
- **Only committed work is listed** in the Changes pane (uncommitted files are not in the land); the Checkpoints dialog does show what a turn changed, uncommitted included.
- **No badge on the rail**, only in the three lists.
- **Restricted environments:** two cockpit tests that need a pty / unix socket still fail inside a sandbox, as before; they pass outside it. The live script must run outside the sandbox (it
  denies reading files of this kind and the fixture needs `git add`).

## Ideas not built

Token-shape scanning of added lines, a rail chip, per-project patterns, asking in `Land all ready` and in `cw land`, a `patch: false` option on `session.diff`, asking when a dependency is
*added* (not only badging), and a "couldn't list the files, land anyway?" question for the diff-read failure. This closes the four-feature series (checkpoints, diff comments, auto-check,
sensitive-file flags).
