# Sensitive-file flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Label the risky files in a session's diff (secret, automation, migration, dependency) in the Changes pane, the Checkpoints dialog and Compare, summarise them in one line, and ask before **Land** when the session touches a secret-like or automation file.

**Architecture:** One pure classifier in `src/core/sensitive-files.ts` (path → kind, plus summary and the set of kinds that make Land ask). Two tiny hook-free Preact views (`SensitiveBadge`, `SensitiveSummary`) are placed in the three file lists. `landSensitiveWarning` (pure) builds the confirmation; `handleLand` reads the session's committed files with `api.sessionDiff` and asks first. Cockpit only; no daemon, RPC, CLI or schema change.

**Tech Stack:** Bun, TypeScript strict, Preact (`@jsxImportSource preact` pragma in every `.tsx`), `bun test` at the repo root (which also loads cockpit tests) and in `apps/cockpit`.

**Spec:** `docs/superpowers/specs/2026-10-10-sensitive-files-design.md`

## Global Constraints

- `SCHEMA_VERSION` stays 18; no new dependency; no native module; macOS/Linux only.
- The classifier reads **only a path string**: no file read, no execution, no content scan.
- One kind per path; priority **secret → automation → migration → dependency**; case-insensitive; forward slashes; any depth.
- `LAND_ASKS` is exactly `secret` and `automation`. A failed or impossible diff read never blocks or changes a land.
- Colours only through tokens (the tokens test forbids literals and orphan `var()`); every new `.tsx` starts with `/** @jsxImportSource preact */`.
- The cockpit imports the classifier as `../../../../src/core/sensitive-files.js` (as `redact-secrets` and `argv` are).
- Gates one at a time, never concurrently with another test run (the machine runs hot; a land test timed out once under load). Root suite outside the sandbox.
- Comments explain WHY; user-facing copy in English; tests pin behaviour, not strings of logs.

## Review Focus

- A path git prints quoted or with spaces/non-ASCII (the diff parser unquotes it): must classify like any other.
- `.env` family edges: `.env`, `.env.production`, `.env.local.example` (final suffix decides), `.ENV`, `sub/dir/.env.test`, `.environment` and `.envrc` (must NOT match `.env.`), `env.example`, `my.env`.
- Directory-vs-file edges: `migrate.ts`, `migrations.ts`, `src/migrations/001.sql`, `db/migrate/x.rb`, `alembic/versions/a.py`, `a/migrations` (a *file* named migrations at the end is not a directory segment).
- Priority collisions: `.github/workflows/package.json`, `migrations/.env`, `.claude/hooks/secrets.json`, `config/secrets.json`, `docker/Dockerfile`.
- A deleted file flagged exactly like an edited one; a rename arrives as delete + add.
- Land: `session.diff` throwing, a shared-checkout session (no branch), a huge diff (the RPC returns the whole patch for one `git diff`), the session list changing mid-await, and the confirmation body being untrusted path text.
- Compare shows two sessions' lists: both must get badges and the summary per side.

---

### Task 1: The classifier (`src/core/sensitive-files.ts`)

**Files:**
- Create: `src/core/sensitive-files.ts`
- Test: `tests/core/sensitive-files.test.ts`

**Interfaces:**

```ts
export type SensitiveKind = 'secret' | 'automation' | 'migration' | 'dependency'
export const SENSITIVE_KINDS: readonly SensitiveKind[]            // fixed display order: secret, dependency, migration, automation
export const SENSITIVE_LABEL: Record<SensitiveKind, string>        // 'secret' | 'dependency' | 'migration' | 'automation'
export const SENSITIVE_REASON: Record<SensitiveKind, string>       // one plain sentence each (the tooltip)
export const LAND_ASKS: ReadonlySet<SensitiveKind>                 // secret, automation
export function sensitiveKind(path: string): SensitiveKind | null
export function summarizeSensitive(paths: readonly string[]): { total: number; byKind: Array<{ kind: SensitiveKind; paths: string[] }> }
```

`SENSITIVE_KINDS` is the *display* order of the summary line (`1 secret · 1 dependency · 1 automation` as in the spec's example is secret, dependency, automation — keep: secret, dependency, migration, automation); the *match priority* is a separate internal order (secret, automation, migration, dependency).

- [ ] **Step 1: Write the failing table test** — rows `[path, expected]` for every line of the spec's matching table and every Review Focus edge above (e.g. `['.env', 'secret']`, `['apps/web/.env.production', 'secret']`, `['.env.example', null]`, `['.env.local.example', null]`, `['.ENV.PRODUCTION', 'secret']`, `['.envrc', null]`, `['.environment', null]`, `['id_rsa', 'secret']`, `['id_rsa.pub', null]`, `['deploy/server.PEM', 'secret']`, `['credentials.json', 'secret']`, `['secrets.yml', 'secret']`, `['.github/workflows/ci.yml', 'automation']`, `['x/.github/actions/a/action.yml', 'automation']`, `['.github/CODEOWNERS', null]`, `['Dockerfile', 'automation']`, `['svc/Dockerfile.dev', 'automation']`, `['docker-compose.override.yaml', 'automation']`, `['crossweave.config.json', 'automation']`, `['.claude/settings.local.json', 'automation']`, `['.claude/hooks/pre.sh', 'automation']`, `['.claude/agents/a.md', null]`, `['db/migrate/20240101_x.rb', 'migration']`, `['src/migrations/001.sql', 'migration']`, `['alembic/versions/a.py', 'migration']`, `['migrate.ts', null]`, `['src/migrations.ts', null]`, `['package.json', 'dependency']`, `['requirements-dev.txt', 'dependency']`, `['go.sum', 'dependency']`, `['bun.lockb', 'dependency']`, `['README.md', null]`, `['src/index.ts', null]`, `['', null]`) plus the collisions (`.github/workflows/package.json` → automation, `migrations/.env` → secret, `config/secrets.json` → secret). `summarizeSensitive`: kinds in display order, kinds with no file omitted, paths in input order, `total` counts flagged files only, `[]` gives `{ total: 0, byKind: [] }`. `LAND_ASKS` equals `new Set(['secret','automation'])`. Every kind has a non-empty label and reason.
- [ ] **Step 2:** `bun test tests/core/sensitive-files.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.**

```ts
const lower = (s: string): string => s.toLowerCase()

function isSecret(base: string): boolean {
  if (base === '.env') return true
  if (base.startsWith('.env.')) return !PLACEHOLDER.has(base.slice(base.lastIndexOf('.') + 1))
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true
  if (['.npmrc', '.netrc', '.pypirc', '.git-credentials', 'credentials'].includes(base)) return true
  return base.startsWith('credentials.') || base.startsWith('secret.') || base.startsWith('secrets.')
}
// automation: dir segments + basenames as in the spec; migration: dirs.includes('migrations'|'migrate') or an adjacent alembic,versions pair;
// dependency: a Set of manifest and lockfile basenames + /^requirements-.+\.txt$/ (and 'requirements.txt' in the set)
export function sensitiveKind(path: string): SensitiveKind | null {
  const parts = lower(path).split('/').filter((p) => p !== '')
  const base = parts.at(-1)
  if (base === undefined) return null
  const dirs = parts.slice(0, -1)
  if (isSecret(base)) return 'secret'
  if (isAutomation(base, dirs)) return 'automation'
  if (isMigration(dirs)) return 'migration'
  if (isDependency(base)) return 'dependency'
  return null
}
```

- [ ] **Step 4:** run → PASS; `bun run typecheck`.
- [ ] **Step 5:** commit `feat(core): classify the files of a diff that deserve a closer look`.

### Task 2: Views and the land question (cockpit lib/ui, pure)

**Files:**
- Create: `apps/cockpit/src/ui/SensitiveBadge.tsx`
- Modify: `apps/cockpit/src/lib/rail.ts` (beside `landCheckWarning`): `landSensitiveWarning`
- Test: `apps/cockpit/tests/sensitive-badge.test.tsx`, extend `apps/cockpit/tests/rail.test.ts`

**Interfaces:**

```tsx
export function SensitiveBadge({ path }: { path: string }): VNode | null          // nothing, or <span class="cockpit-sensitive is-KIND" title=REASON>LABEL</span>
export function SensitiveSummary({ paths }: { paths: readonly string[] }): VNode | null   // nothing at 0, else <p class="cockpit-muted cockpit-changes__note">3 sensitive files: 1 secret · 1 dependency · 1 automation</p>
// rail.ts
export function landSensitiveWarning(name: string, paths: readonly string[]): { title: string; body: string; confirmLabel: string } | undefined
```

`landSensitiveWarning`: only files whose kind is in `LAND_ASKS`; none → `undefined`; title `Land <name> with sensitive files?`; body one line per file `<path> — <label>` (max 8, then `and N more`) preceded by one sentence saying these look like secrets or files that run commands and that this is a name check only; `confirmLabel: 'Land anyway'`.

- [ ] **Step 1: Failing tests** (walk style of `checkpoints.test.tsx`): the badge is `null` for `README.md`, a span with the kind class, the label text and the reason in `title` for `.env.production`; the summary is `null` at zero, singular/plural (`1 sensitive file`, `2 sensitive files`), kinds in display order, only kinds present; `landSensitiveWarning` undefined for `[]`, for lockfile+migration only, defined for `['package.json', '.github/workflows/ci.yml', 'src/a.ts']` listing only the workflow, 9 asking files → 8 lines + `and 1 more`, a path containing a newline or markup is carried as plain text on one line (newlines in a path replaced by a space).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `cd apps/cockpit && bun test tests/sensitive-badge.test.tsx tests/rail.test.ts` and from the repo root `bun test apps/cockpit/tests/sensitive-badge.test.tsx` (the pragma) → PASS; `bun run typecheck`.
- [ ] **Step 5:** commit `feat(cockpit): sensitive-file badge, summary and the land question`.

### Task 3: Place them in the three lists + styles

**Files:**
- Modify: `apps/cockpit/src/ui/ChangesPane.tsx`, `apps/cockpit/src/ui/CheckpointsDialog.tsx`, `apps/cockpit/src/ui/CompareView.tsx`, `apps/cockpit/src/ui/app.css`

- [ ] **Step 1:** In each file row add `<SensitiveBadge path={f.path} />` between the path and the `+n −n` count; add `<SensitiveSummary paths={files.map((f) => f.path)} />` under the totals line (ChangesPane after the totals paragraph; CheckpointsDialog under the title row; CompareView once per side).
- [ ] **Step 2:** CSS `.cockpit-sensitive` (small pill, `var(--cw-radius-sm)`, `var(--cw-fs-sm)`, `flex: none`) with a per-kind colour from existing tokens (secret → `--cw-blocked`, automation → `--cw-needs-you`, migration → `--cw-accent`, dependency → `--cw-text-dim`) on `var(--cw-surface-badge)`; keep WCAG AA (the tokens test checks the pairs it knows; add the new pairs to the test if it enumerates them).
- [ ] **Step 3:** `cd apps/cockpit && bun run build` and `bun test tests/tokens.test.ts` → PASS.
- [ ] **Step 4:** commit `feat(cockpit): flag sensitive files in Changes, Checkpoints and Compare`.

### Task 4: Ask before Land

**Files:**
- Modify: `apps/cockpit/src/ui/ProjectView.tsx` (`handleLand`)

- [ ] **Step 1:** In `handleLand`, after the `target` guard and before `landCheckWarning`, when `target.branch !== null`: `const files = await api.sessionDiff(target.id).then((d) => d.files.map((f) => f.path), () => [] as string[])`; `const ask = landSensitiveWarning(target.name, files)`; `if (ask !== undefined && !(await hostRef.current.askConfirm(ask))) return`. A rejected read gives `[]` → no question.
- [ ] **Step 2:** `cd apps/cockpit && bun run build` → PASS; `bun test` → only the two known sandbox failures if sandboxed.
- [ ] **Step 3:** commit `feat(cockpit): ask before landing a session that touches secret or automation files`.

### Task 5: Live check, limits doc, gates

**Files:**
- Create: `apps/cockpit/scripts/sensitive-files-check.ts`, `docs/superpowers/specs/2026-10-10-sensitive-files-known-limitations.md`; one line appended to `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`; memory `ai-support-feature-series.md`.

- [ ] **Step 1:** CDP script (pattern: `diff-comments-check.ts`): scratch session; in its worktree (found via `session.list`) write `.env.production`, change `package.json`, add `.github/workflows/ci.yml`, `git add` and `git commit` them there; open the row menu → **Changes**; assert the three badges (text), the summary `3 sensitive files: …`, then press **Land** and assert the dialog title and that the body names `.env.production` and the workflow but not `package.json`; cancel; assert the session is still listed (not landed).
- [ ] **Step 2:** gates, one at a time and nothing else running: `bun run typecheck`; `bun test --max-concurrency=1` (outside the sandbox); `cd apps/cockpit && bun test` (outside the sandbox); `bun run build` in the cockpit; the live script. Clean up Electron, daemons and scratch dirs (move to Trash).
- [ ] **Step 3:** limitations file (from the spec's "Known limits" plus findings) and the digest line; commit the script and docs separately.
