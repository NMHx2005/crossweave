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
