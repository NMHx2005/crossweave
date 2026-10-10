# Sensitive-file flags — make the risky files in a session's diff stand out

**Date:** 2026-10-10
**Status:** Draft for review (the design was approved in chat 2026-10-10; this written spec is new)
**Branch:** `feat/sensitive-files` (fourth of four: checkpoints → diff comments → auto-check → **sensitive-file flags**; cut from `main`, which holds the first three)

## Why

An agent's diff is a list of files. The ones that deserve the closest look — a committed `.env.production`, a new dependency in `package.json`, a migration, a
CI workflow, the repository's own `crossweave.config.json` (which carries the test command and the hooks) — look exactly like the rest, and a list of dozens
scrolls them away. Nothing marks them, and landing asks nothing about them.

Success looks like: open Changes, Checkpoints or Compare and the sensitive files carry a labelled badge with the reason, a one-line summary says how many of
each kind, and pressing **Land** on a session that touches a secret-like or automation file asks first and names the files.

## Non-goals

- **Not a secret scanner.** Names and paths only; the content of a patch is never read. A key pasted into a `.ts` file is not flagged. (Scanning added lines with
  `redactSecrets` is a different feature, prone to false positives; it is listed under ideas.)
- No user-configurable patterns, no per-project list, no allow-list: a constant in code.
- No daemon, RPC, CLI, database or schema change (`SCHEMA_VERSION` stays 18), no new dependency, no native module.
- Ignored files never appear in a diff (git does not list them), so a real `.env` is invisible here by design; the flags catch what *was* committed or checkpointed.

## The classification (`src/core/sensitive-files.ts`, pure)

`sensitiveKind(path: string): SensitiveKind | null` with `SensitiveKind = 'secret' | 'automation' | 'migration' | 'dependency'`. A path has at most one kind;
when several match, the order is **secret → automation → migration → dependency**. Matching is on the path as git prints it (forward slashes), **case-insensitive**,
by basename or by directory segment, at any depth (`apps/web/.env.production` matches as `.env.production`).

| Kind | Matches |
|---|---|
| `secret` | basename `.env` or `.env.<anything>` **except** a final suffix of `example`, `sample`, `template`; `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`; `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` (not `*.pub`); `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`; `credentials`, `credentials.*`; `secret.*`, `secrets.*` |
| `automation` | a directory segment `.github` followed by `workflows` or `actions`; `.circleci/`, `.buildkite/`, `.husky/`, `.githooks/`; basenames `.gitlab-ci.yml`, `Jenkinsfile`, `azure-pipelines.yml`, `.pre-commit-config.yaml`, `Dockerfile`, `Dockerfile.*`, `docker-compose*.yml/.yaml`, `compose.yml/.yaml`, `crossweave.config.json`, `.mcp.json`; `.claude/settings.json`, `.claude/settings.local.json`, anything under `.claude/hooks/` |
| `migration` | any directory segment `migrations`, or `migrate` (as in `db/migrate`), or the pair `alembic/versions` — a *directory*, not a file named `migrate.ts` |
| `dependency` | manifests `package.json`, `pyproject.toml`, `requirements.txt`, `requirements-*.txt`, `Pipfile`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `pom.xml`, `build.gradle`, `build.gradle.kts`; lockfiles `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `go.sum`, `composer.lock`, `packages.lock.json`, `gradle.lockfile` |

Also exported: `SENSITIVE_LABEL: Record<SensitiveKind, string>` (`secret`, `dependency`, `migration`, `automation` — words as well as colour), `SENSITIVE_REASON:
Record<SensitiveKind, string>` (one plain sentence each, the tooltip), `summarizeSensitive(paths) → { total: number; byKind: Array<{ kind; paths: string[] }> }` (kinds in the
fixed order above, paths in input order, kinds with no file omitted), and `LAND_ASKS: ReadonlySet<SensitiveKind>` = `secret` and `automation`.

## Where it shows

- **Badge.** A pure `SensitiveBadge({ path })` renders nothing for an ordinary file and `<span class="cockpit-sensitive is-<kind>" title="<reason>">secret</span>` for a
  flagged one. It sits between the path and the `+n −n` count in the file lists of `ChangesPane`, `CheckpointsDialog` and `CompareView` (both sides).
- **Summary.** A pure `SensitiveSummary({ paths })` renders nothing at zero, else one line above the list: `3 sensitive files: 1 secret · 1 dependency · 1 automation`.
  Placed under the existing totals line in each of the three places.
- **Land.** `handleLand` reads the session's committed files with `api.sessionDiff(id)` (one `git diff`) and, when any file's kind is in `LAND_ASKS`, asks first with
  `landSensitiveWarning(name, paths) → ConfirmRequest | undefined`: title `Land <name> with sensitive files?`, a body that lists up to 8 files with their kinds and says
  `and N more`, `confirmLabel: 'Land anyway'`. It comes **before** the existing failing-tests warning, and either "no" stops the land. `dependency` and `migration`
  are badge-only: lockfiles change on almost every land, and a question that is always asked teaches people to click through. If the diff cannot be read (an RPC error,
  a session without a branch) no question is asked and the land proceeds as before: a failing look must never be the reason a land is blocked or silently different.

## Units

- `src/core/sensitive-files.ts` (new, pure); imported by the cockpit through `../../../../src/core/sensitive-files.js` (as `redact-secrets` and `argv` already are).
- `apps/cockpit/src/ui/SensitiveBadge.tsx` (new, `@jsxImportSource preact` pragma): `SensitiveBadge`, `SensitiveSummary`.
- `apps/cockpit/src/lib/land-actions.ts` or `rail.ts` (beside `landCheckWarning`): `landSensitiveWarning`.
- `ChangesPane.tsx`, `CheckpointsDialog.tsx`, `CompareView.tsx`: badge in each file row, summary under the totals. `ProjectView.tsx`: the land question. `app.css`: tokens only.

## Edge cases

| Case | Behaviour |
|---|---|
| `.env.example` / `.env.sample` / `.env.template` | not flagged (they are the documented placeholders) |
| `.env.local.example`, `.ENV.PRODUCTION` | the final suffix decides: `.example` is not flagged; case is ignored, so the second is |
| `docs/migrate.ts`, `src/migrations.ts` | not flagged: only a directory segment counts |
| `node_modules/x/package.json` | flagged as `dependency` (committed vendored copies are rare; the badge is harmless) |
| `a/.github/workflows/ci.yml` | flagged `automation` at any depth |
| A path with spaces, non-ASCII or quotes | matched as is (the diff parser already unquotes it) |
| Deleted file | flagged the same: removing a CI workflow or a lockfile is as notable as editing it |
| Renames | the diff is `--no-renames`: a rename is a delete plus an add, each judged on its own path |
| Empty list | no summary, no badges, no question |
| Land: `session.diff` throws or the session has no branch | no question, land proceeds |
| Land all ready | does not ask (it does not ask about failing tests either); recorded as a limit |

## Testing

- `sensitive-files` (pure, a table of paths → kind): every row of the matching table, both sides of each exception (`.env.example` vs `.env.production`, `id_rsa` vs `id_rsa.pub`,
  `migrations/` dir vs `migrate.ts` file), priority (`.github/workflows/package.json` is `automation`, `config/secrets.json` is `secret`), case, depth, Windows-looking
  input is not special. `summarizeSensitive` order and omission. `LAND_ASKS` is exactly secret and automation.
- `landSensitiveWarning`: undefined for dependency/migration-only and for none; lists kinds and files, caps at 8 with `and N more`; title and label.
- Walk tests: `SensitiveBadge` (nothing / a labelled span with the reason as `title`), `SensitiveSummary` (nothing at zero; counts and order).
- A live script `apps/cockpit/scripts/sensitive-files-check.ts` on the running cockpit: a session whose branch commits a `.env.production`, a `package.json` change and a
  workflow; the Changes pane shows the three badges and `3 sensitive files: …`; **Land** asks, the dialog names the secret and the workflow but not the dependency; Cancel
  leaves the session unlanded.

## Security

- The classification reads only a path and produces a label: no execution, no file read, no network. Paths come from a repository an agent can write; they are rendered
  as text (Preact escapes) and placed in a dialog body as plain text.
- It can **fail open and mislead**: an unflagged file is not a safe file (a heuristic on names), a flagged one may be harmless. The summary says "sensitive", never "safe".
  A hostile name designed to dodge the table (a secret in `config.txt`) is not caught; that is why content scanning is called out as not built.
- The land question is a convenience, not a gate: `cw land`, `Land all ready` and a land from another client are not affected.

## Known limits to record

Names only, no content; ignored files invisible; fixed patterns (no configuration, no monorepo-specific lists); `Land all ready` and `cw land` do not ask; a
diff read on every Land costs one `git diff`; the badge appears only where a file list is shown (not on the rail); the committed-diff panes miss uncommitted files by design.
Ideas: scanning added lines for token shapes, a rail chip, per-project patterns, asking in `Land all ready` and in the CLI.

---

## Amendments from the adversarial review (these supersede conflicting text above)

The review (Opus, read-only) ran this classifier over ~110 paths and the proposed badge colours through every theme. No blocker; two major defects, both adopted.

**Classifier changes.**
- **`secret.*` / `secrets.*` / `credentials.*` only count with a data extension** (`json yaml yml toml env ini conf cfg properties txt xml`), and never when any dot-part of the
  name is `example`, `sample` or `template`. Run results of the first draft: `src/secrets.ts`, `src/secret.service.ts`, `lib/credentials.ts`, `docs/credentials.md` were all flagged `secret`, which
  would make Land ask in any repo with a secrets module — the click-through habit this feature must not teach. A bare `credentials` (no extension, like `~/.aws/credentials`) stays flagged.
- **Added to `secret`:** `*.tfstate`, `*.tfstate.backup` (Terraform state holds plaintext secrets), `kubeconfig`, `.kube/config`, any file under a `.ssh/` directory, `.docker/config.json`, and a
  data-extension file under a `secrets/` directory (`secrets/prod.json`).
- **Added to `automation`:** `.vscode/tasks.json`, anything under `.devcontainer/` (both can run commands when a folder is opened), `.travis.yml`, `bitbucket-pipelines.yml`, `lefthook.yml/.yaml`,
  and `mcp.json` directly under `.cursor/` or `.vscode/` (the same reason `.mcp.json` is listed). `Dockerfile.*` is **not** flagged when the extension is `md` or `txt`.
- **Added to `dependency`:** `setup.py`.
- Deliberately **left out** (they churn or execute nothing): `Makefile`, `Procfile`, `.github/dependabot.yml`, `CLAUDE.md` / `AGENTS.md`. Agent-instruction files are recorded as a limit. `.git/hooks`
  never appears in a diff.
- **One order, everywhere:** secret → automation → migration → dependency, for matching *and* for the summary line (the kinds that make Land ask come first). The spec's example reads
  `3 sensitive files: 1 secret · 1 automation · 1 dependency`. There is no separate display order.
- `SENSITIVE_REASON.dependency` says a manifest can change install and test scripts (`postinstall`), not only which libraries are used.

**Land.**
- A **single in-flight guard** (`landingRef`, set before the first `await`, cleared in `finally`) wraps the whole `handleLand`: the new diff read is an `await` before `setLandBusy(true)`, so a double-click
  (or a click plus the `land` command) would otherwise reach `landSelected` twice, or open two confirmations of which `App.askConfirm` abandons the first one's promise (a `handleLand` that never returns).
- The read is fail-safe: `api.sessionDiff(...).then((d) => paths).catch(() => [])` (a throw in the success handler is also caught) and the guard is `target.branch != null`.
- When both the sensitive-file question and the failing-tests question apply, they are **one dialog** (`combineWarnings`): title `Land <name> anyway?`, the two bodies one after the other. Either alone keeps its own title.
- The body is sanitised: `\r`, `\n`, `\t` and bidi/control characters (U+202A–202E, U+2066–2069, C0/C1) in a path become a space; `.cockpit-confirm__body` gets `overflow-wrap: anywhere`.
- Known and recorded, not fixed: a text diff over the daemon's 64 MB buffer throws, so an agent that produces one makes the question skip (the land proceeds as before); every Land fetches the whole patch
  (up to 512 KB) just to read names; the list is read when the dialog opens and the branch tip can move before the merge; a new dependency or a changed script in `package.json` does not ask.

**Badge.** The reason is also in the DOM for assistive technology: a visually hidden `<span class="cockpit-sr-only"> — reason</span>` after the label, besides the hover `title`.
**Placement.** Checkpoints: the summary goes right after the shown diff's `<h3 class="cockpit-changes__file">` line. Compare: the badge goes after the path and before the existing `both` pill, per side.
**Tokens.** `blocked`, `needs-you`, `accent` and `text-dim` on `--cw-surface-badge` are registered as pairs in the tokens test (measured ≥ 4.81:1 in all six themes).
