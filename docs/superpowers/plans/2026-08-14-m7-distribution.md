# M7 Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give crossweave a real install path (`curl | sh`) backed by a
GitHub Actions release pipeline, and an opt-out self-update check built
into `cw` itself.

**Architecture:** Three independent pieces (release pipeline, install
script, self-update checker) that only share one contract: a fixed
asset-naming convention on a GitHub Release. Self-update state lives in a
new global file, `~/.crossweave/config.json`, separate from the existing
per-repo `crossweave.config.json`.

**Tech Stack:** Bun (`fetch` built in, no new dependency), TypeScript,
citty (existing CLI framework), bash (`install.sh`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-14-m7-distribution-design.md`

## Global Constraints

- Repo: `NMHx2005/crossweave` (real, public, already exists) — use this
  exact string everywhere the spec calls for org/repo, never a placeholder.
- Target platforms: `darwin-arm64`, `darwin-x64`, `linux-x64` only (spec §4,
  §1 non-goals — no Windows).
- Checksum verification (sha256, against a `checksums.txt` published in the
  same release) is **mandatory**, both in `install.sh` and in `cw update` —
  never install or execute an unverified download. This is the one
  load-bearing security control in this plan (spec §9).
- No `sudo` anywhere in this plan's code — install target is always
  `~/.local/bin`, config lives under `~/.crossweave/`.
- Self-update state (`updateCheck`, `lastCheckedAt`, `lastKnownLatest`,
  `lastNotifiedVersion`) lives in `~/.crossweave/config.json`, never in the
  existing per-repo `crossweave.config.json` (spec §6 — this is a property
  of the installed binary, not of any one workspace).
- The version compared against "latest" is always the CLI's own baked-in
  `VERSION` (from `src/core/version.ts`, sourced from `package.json`) — the
  actual running binary's ground truth — never a separately-stored
  "installed version" string that could drift from what's actually
  running. (This refines spec §6's example JSON slightly: `installedVersion`
  in the global config file is written by `install.sh` for the human's own
  reference — e.g. `cw update`'s "what am I about to overwrite" print — and
  is never read by the comparison logic itself.)
- Version strings are compared with a leading `v` stripped from either
  side (tags are `v0.1.0`; `package.json`'s `version` field is `0.1.0`) —
  every module in this plan that touches a version string must handle both
  forms.
- **No task in this plan pushes to the real remote, creates a git tag, or
  triggers the GitHub Actions workflow for real.** Every task's deliverable
  is code, verified by `bun test`/`bun run typecheck` and, where the spec's
  own §8 calls for it, a documented manual-verification checklist — never
  a live push. Cutting the first real release tag is a separate,
  human-triggered action after this branch is reviewed and merged, exactly
  like this project's existing "ask before pushing" discipline. If any
  task's own text seems to imply pushing/tagging for real, that's a plan
  defect — stop and rule it out rather than doing it.
- Every new network call (`fetch`) takes an injectable base URL and/or
  fetch implementation as a constructor/function parameter, defaulting to
  the real one — tests must never hit the real network (existing project
  rule: "tests must be deterministic — no real network, clock, or
  randomness without a controllable seam").

---

### Task 1: Global config module

**Files:**
- Modify: `src/core/paths.ts`
- Create: `src/update/global-config.ts`
- Test: `tests/update/global-config.test.ts`

**Interfaces:**
- Produces: `globalCrossweaveDir(homeDir?: string): string` (added to
  `paths.ts`, exported alongside the existing `crossweaveDir`).
  `GlobalConfig` interface, `DEFAULT_GLOBAL_CONFIG`,
  `loadGlobalConfig(homeDir?: string): GlobalConfig`,
  `saveGlobalConfig(cfg: GlobalConfig, homeDir?: string): void` (all in
  `global-config.ts`). The optional `homeDir` param on every function is
  the test seam — production call sites omit it and get `os.homedir()`.

- [ ] **Step 1: Add `globalCrossweaveDir` to `src/core/paths.ts`**

Add near the existing `crossweaveDir`:

```typescript
import { homedir } from 'node:os';
// ... existing imports stay as-is

export function globalCrossweaveDir(homeDir: string = homedir()): string {
  return join(homeDir, '.crossweave');
}
```

- [ ] **Step 2: Write the failing tests for `global-config.ts`**

```typescript
// tests/update/global-config.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadGlobalConfig,
  saveGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
} from '../../src/update/global-config.js';
import { globalCrossweaveDir } from '../../src/core/paths.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-global-config-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('global-config', () => {
  test('loadGlobalConfig returns defaults when no file exists', () => {
    expect(loadGlobalConfig(home)).toEqual(DEFAULT_GLOBAL_CONFIG);
  });

  test('saveGlobalConfig then loadGlobalConfig round-trips', () => {
    const cfg = {
      ...DEFAULT_GLOBAL_CONFIG,
      installedVersion: 'v0.1.0',
      updateCheck: false,
      lastCheckedAt: '2026-08-14T00:00:00.000Z',
      lastKnownLatest: 'v0.2.0',
      lastNotifiedVersion: 'v0.2.0',
    };
    saveGlobalConfig(cfg, home);
    expect(loadGlobalConfig(home)).toEqual(cfg);
  });

  test('saveGlobalConfig creates ~/.crossweave if missing', () => {
    saveGlobalConfig(DEFAULT_GLOBAL_CONFIG, home);
    expect(existsSync(globalCrossweaveDir(home))).toBe(true);
  });

  test('a malformed config.json falls back to defaults rather than throwing', () => {
    saveGlobalConfig(DEFAULT_GLOBAL_CONFIG, home);
    const path = join(globalCrossweaveDir(home), 'config.json');
    require('node:fs').writeFileSync(path, '{not json');
    expect(loadGlobalConfig(home)).toEqual(DEFAULT_GLOBAL_CONFIG);
  });

  test('written file is valid JSON on disk', () => {
    saveGlobalConfig(DEFAULT_GLOBAL_CONFIG, home);
    const path = join(globalCrossweaveDir(home), 'config.json');
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/update/global-config.test.ts`
Expected: FAIL — `src/update/global-config.ts` does not exist yet.

- [ ] **Step 4: Implement `src/update/global-config.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { globalCrossweaveDir } from '../core/paths.js';

export interface GlobalConfig {
  installedVersion: string | null;
  updateCheck: boolean;
  lastCheckedAt: string | null;
  lastKnownLatest: string | null;
  lastNotifiedVersion: string | null;
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  installedVersion: null,
  updateCheck: true,
  lastCheckedAt: null,
  lastKnownLatest: null,
  lastNotifiedVersion: null,
};

function configPath(homeDir: string | undefined): string {
  return join(globalCrossweaveDir(homeDir), 'config.json');
}

/**
 * A malformed or missing file both fall back to defaults rather than
 * throwing — this is read on every `cw` invocation (indirectly, via the
 * update checker), and a corrupt global config must never take down an
 * unrelated command. Mirrors this project's existing posture on
 * observability-not-safety state (see `notify()`'s own doc comment).
 */
export function loadGlobalConfig(homeDir?: string): GlobalConfig {
  const path = configPath(homeDir);
  if (!existsSync(path)) return DEFAULT_GLOBAL_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { ...DEFAULT_GLOBAL_CONFIG, ...raw };
  } catch {
    return DEFAULT_GLOBAL_CONFIG;
  }
}

export function saveGlobalConfig(cfg: GlobalConfig, homeDir?: string): void {
  const dir = globalCrossweaveDir(homeDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(homeDir), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/update/global-config.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck` — 0 errors.

```bash
git add src/core/paths.ts src/update/global-config.ts tests/update/global-config.test.ts
git commit -m "feat(update): global config file (~/.crossweave/config.json)"
```

---

### Task 2: Semver parse/compare

**Files:**
- Create: `src/update/semver.ts`
- Test: `tests/update/semver.test.ts`

**Interfaces:**
- Produces: `parseSemver(raw: string): { major: number; minor: number; patch: number } | undefined`
  (strips a leading `v` if present; `undefined` on anything that doesn't
  parse as `\d+\.\d+\.\d+` with an optional pre-release/build suffix which
  is ignored for comparison purposes), `isNewerVersion(candidate: string, current: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/update/semver.test.ts
import { describe, expect, test } from 'bun:test';
import { parseSemver, isNewerVersion } from '../../src/update/semver.js';

describe('parseSemver', () => {
  test('parses a bare version', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  test('strips a leading v', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  test('ignores a pre-release/build suffix', () => {
    expect(parseSemver('v1.2.3-rc1')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  test('returns undefined for garbage', () => {
    expect(parseSemver('not-a-version')).toBeUndefined();
    expect(parseSemver('')).toBeUndefined();
    expect(parseSemver('1.2')).toBeUndefined();
  });
});

describe('isNewerVersion', () => {
  test('major/minor/patch each independently make a version newer', () => {
    expect(isNewerVersion('v2.0.0', 'v1.9.9')).toBe(true);
    expect(isNewerVersion('v1.3.0', 'v1.2.9')).toBe(true);
    expect(isNewerVersion('v1.2.4', 'v1.2.3')).toBe(true);
  });
  test('an equal or older version is not newer', () => {
    expect(isNewerVersion('v1.2.3', 'v1.2.3')).toBe(false);
    expect(isNewerVersion('v1.2.2', 'v1.2.3')).toBe(false);
  });
  test('mixed v-prefix and bare both compare correctly', () => {
    expect(isNewerVersion('1.2.4', 'v1.2.3')).toBe(true);
  });
  test('an unparseable candidate or current is never newer', () => {
    expect(isNewerVersion('garbage', 'v1.2.3')).toBe(false);
    expect(isNewerVersion('v1.2.4', 'garbage')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/update/semver.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/update/semver.ts`**

```typescript
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export interface Semver { major: number; minor: number; patch: number }

export function parseSemver(raw: string): Semver | undefined {
  const m = SEMVER_RE.exec(raw);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** `undefined` on either side (unparseable input) is conservatively "not newer" — never prompt an update off a version string we can't actually read. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const c = parseSemver(candidate);
  const cur = parseSemver(current);
  if (c === undefined || cur === undefined) return false;
  if (c.major !== cur.major) return c.major > cur.major;
  if (c.minor !== cur.minor) return c.minor > cur.minor;
  return c.patch > cur.patch;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/update/semver.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/update/semver.ts tests/update/semver.test.ts
git commit -m "feat(update): semver parse/compare"
```

---

### Task 3: Update checker

**Files:**
- Create: `src/update/checker.ts`
- Test: `tests/update/checker.test.ts`

**Interfaces:**
- Consumes: `loadGlobalConfig`/`saveGlobalConfig`/`GlobalConfig` from Task 1
  (`src/update/global-config.js`), `isNewerVersion` from Task 2
  (`src/update/semver.js`).
- Produces:
  ```typescript
  export interface UpdateCheckDeps {
    homeDir?: string;
    clock?: () => number;              // default: Date.now
    fetchFn?: typeof fetch;            // default: global fetch
    repo?: string;                     // default: 'NMHx2005/crossweave'
  }
  export async function checkForUpdate(currentVersion: string, deps?: UpdateCheckDeps): Promise<string | undefined>;
  ```
  Returns the one-line notice to print, or `undefined` if nothing to show
  (checking disabled, still within the 24h cache window, no newer version,
  already notified for this version, or the network call failed).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/update/checker.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate } from '../../src/update/checker.js';
import { loadGlobalConfig, saveGlobalConfig, DEFAULT_GLOBAL_CONFIG } from '../../src/update/global-config.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-checker-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function fakeFetch(tagName: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ tag_name: tagName }), { status: 200 })) as unknown as typeof fetch;
}

describe('checkForUpdate', () => {
  test('returns a notice when a newer version is published', async () => {
    const notice = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: fakeFetch('v0.2.0') });
    expect(notice).toContain('v0.2.0');
    expect(notice).toContain('0.1.0');
    expect(notice).toContain('cw update');
  });

  test('returns undefined when already on the latest version', async () => {
    const notice = await checkForUpdate('0.2.0', { homeDir: home, fetchFn: fakeFetch('v0.2.0') });
    expect(notice).toBeUndefined();
  });

  test('respects updateCheck: false', async () => {
    saveGlobalConfig({ ...DEFAULT_GLOBAL_CONFIG, updateCheck: false }, home);
    const notice = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: fakeFetch('v0.2.0') });
    expect(notice).toBeUndefined();
  });

  test('does not re-check within the 24h cache window', async () => {
    let calls = 0;
    const countingFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ tag_name: 'v0.2.0' }), { status: 200 });
    }) as unknown as typeof fetch;
    const now = 1_000_000_000_000;
    await checkForUpdate('0.1.0', { homeDir: home, fetchFn: countingFetch, clock: () => now });
    await checkForUpdate('0.1.0', { homeDir: home, fetchFn: countingFetch, clock: () => now + 60_000 });
    expect(calls).toBe(1);
  });

  test('re-checks once 24h have passed', async () => {
    let calls = 0;
    const countingFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ tag_name: 'v0.2.0' }), { status: 200 });
    }) as unknown as typeof fetch;
    const now = 1_000_000_000_000;
    await checkForUpdate('0.1.0', { homeDir: home, fetchFn: countingFetch, clock: () => now });
    await checkForUpdate('0.1.0', { homeDir: home, fetchFn: countingFetch, clock: () => now + 25 * 60 * 60 * 1000 });
    expect(calls).toBe(2);
  });

  test('only notifies once per version, not once per command', async () => {
    const now = 1_000_000_000_000;
    let tick = 0;
    const clock = () => now + (tick++) * 25 * 60 * 60 * 1000; // force a fresh check every call
    const first = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: fakeFetch('v0.2.0'), clock });
    const second = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: fakeFetch('v0.2.0'), clock });
    expect(first).toContain('v0.2.0');
    expect(second).toBeUndefined();
  });

  test('a network failure is swallowed silently and does not update the cache timestamp', async () => {
    const throwingFetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const before = loadGlobalConfig(home).lastCheckedAt;
    const notice = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: throwingFetch });
    expect(notice).toBeUndefined();
    expect(loadGlobalConfig(home).lastCheckedAt).toBe(before);
  });

  test('a non-2xx response is swallowed silently', async () => {
    const failFetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const notice = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: failFetch });
    expect(notice).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/update/checker.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/update/checker.ts`**

```typescript
import { loadGlobalConfig, saveGlobalConfig } from './global-config.js';
import { isNewerVersion } from './semver.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REPO = 'NMHx2005/crossweave';
/** Test/CI seam — overrides the GitHub API host itself, not just the repo path. Read once here so every caller (this module, and Task 7's `cw update`) shares one override mechanism instead of each inventing its own. */
const API_BASE = process.env.CW_UPDATE_API_BASE ?? 'https://api.github.com';

export interface UpdateCheckDeps {
  homeDir?: string;
  clock?: () => number;
  fetchFn?: typeof fetch;
  repo?: string;
}

/**
 * Called on every `cw` invocation (wired in Task 4) — never throws, never
 * blocks longer than a network failure needs to surface, never prints
 * anything itself (the caller decides how/when). Observability, not a
 * safety mechanism: any failure here is swallowed and simply means no
 * notice this time (spec §6).
 */
export async function checkForUpdate(currentVersion: string, deps: UpdateCheckDeps = {}): Promise<string | undefined> {
  const clock = deps.clock ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const repo = deps.repo ?? DEFAULT_REPO;
  const cfg = loadGlobalConfig(deps.homeDir);

  if (!cfg.updateCheck) return undefined;

  const now = clock();
  const cacheIsFresh = cfg.lastCheckedAt !== null && now - Date.parse(cfg.lastCheckedAt) < DAY_MS;

  let latest = cfg.lastKnownLatest;
  if (!cacheIsFresh) {
    try {
      const res = await fetchFn(`${API_BASE}/repos/${repo}/releases/latest`);
      if (!res.ok) return undefined; // swallowed — do not touch lastCheckedAt, retry next invocation
      const body = (await res.json()) as { tag_name?: string };
      if (typeof body.tag_name !== 'string') return undefined;
      latest = body.tag_name;
      saveGlobalConfig({ ...cfg, lastCheckedAt: new Date(now).toISOString(), lastKnownLatest: latest }, deps.homeDir);
    } catch {
      return undefined; // network failure — swallowed, retried next invocation
    }
  }

  if (latest === null || !isNewerVersion(latest, currentVersion)) return undefined;
  if (cfg.lastNotifiedVersion === latest) return undefined;

  saveGlobalConfig({ ...loadGlobalConfig(deps.homeDir), lastKnownLatest: latest, lastNotifiedVersion: latest }, deps.homeDir);
  return `crossweave: ${latest} is available (you have v${currentVersion.replace(/^v/, '')}) — run 'cw update' to install it.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/update/checker.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/update/checker.ts tests/update/checker.test.ts
git commit -m "feat(update): checkForUpdate — cached, opt-out, silent-on-failure"
```

---

### Task 4: Wire the check into the CLI entry point

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/cli/update-check.test.ts`

**Interfaces:**
- Consumes: `checkForUpdate` from Task 3 (`src/update/checker.js`),
  `VERSION` from `src/core/version.js` (already imported in `index.ts`).

**Context you need:** `citty`'s `runMain` (`node_modules/citty/dist/index.mjs`,
`runMain` function) calls `process.exit(0)`/`process.exit(1)` itself on the
`--help`, `--version`, and error paths — code after `await runMain(...)`
never runs for those. It does NOT call `process.exit` on a normal
successful command; the process exits naturally once nothing is pending.
This means the update check can only realistically fire after a normal,
successful command — that's an accepted, documented gap, not a bug to
work around.

`radar-hook` and `session-usage-hook` are internal, high-frequency,
latency-sensitive entry points (Claude Code's `PreToolUse` hook and
`statusLine`, invoked on nearly every tool call) — the update check MUST
be skipped for these two, both to avoid adding a filesystem
read/network-adjacent check to a hot path and because a stray notice line
printed into a hook's stdout could corrupt whatever Claude Code expects
there.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/update-check.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
let fx: GitFixture;
let home: string;

async function run(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: fx.root,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr };
}

beforeEach(async () => {
  fx = await makeGitFixture();
  home = mkdtempSync(join(tmpdir(), 'cw-update-check-cli-'));
});
afterEach(async () => {
  await run(['daemon', 'stop'], { HOME: home });
  await fx.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('update check wiring', () => {
  test('a normal command prints an update notice when one is available', async () => {
    // CW_UPDATE_API_BASE is the test seam checker.ts's HTTP call reads —
    // see Task 3's implementation; this points it at a local fake server.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ tag_name: 'v999.0.0' }), { status: 200 }),
    });
    try {
      const r = await run(['init'], { HOME: home, CW_UPDATE_API_BASE: `http://127.0.0.1:${server.port}` });
      expect(r.stdout).toContain('v999.0.0');
      expect(r.stdout).toContain('cw update');
    } finally {
      server.stop(true);
    }
  });

  test('radar-hook never prints an update notice, even when one is available', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ tag_name: 'v999.0.0' }), { status: 200 }),
    });
    try {
      await run(['init'], { HOME: home, CW_UPDATE_API_BASE: `http://127.0.0.1:${server.port}` });
      const hookInput = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(fx.root, 'x.ts') } });
      const proc = Bun.spawn([process.execPath, CLI, 'radar-hook'], {
        cwd: fx.root,
        env: { ...process.env, HOME: home, CW_UPDATE_API_BASE: `http://127.0.0.1:${server.port}` },
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      proc.stdin.write(hookInput);
      proc.stdin.end();
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      expect(stdout).not.toContain('v999.0.0');
    } finally {
      server.stop(true);
    }
  });
});
```

Read `tests/cli/radar-hook*.test.ts` (or grep `radar-hook` under `tests/`)
first for the exact real stdin shape `radar-hook` expects before finalizing
this test — the JSON shown above is illustrative, match whatever the real
hook input contract already is.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/update-check.test.ts`
Expected: FAIL — `index.ts` doesn't wire anything to `checkForUpdate` yet
(Task 3 already added `CW_UPDATE_API_BASE` support to `checker.ts` itself,
so no changes to that module are needed in this task).

- [ ] **Step 3: Wire the check into `src/cli/index.ts`**

```typescript
// add near the other imports
import { checkForUpdate } from '../update/checker.js';

const INTERNAL_COMMANDS = new Set(['radar-hook', 'session-usage-hook']);

// replace the final `void runMain(main);` with:
await runMain(main);
if (!INTERNAL_COMMANDS.has(process.argv[2] ?? '')) {
  try {
    const notice = await checkForUpdate(VERSION);
    if (notice !== undefined) process.stdout.write(notice + '\n');
  } catch {
    // never let a broken update check take down an otherwise-successful command
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/update-check.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Run the full suite — this changed a shared entry point**

Run: `bun test`
Expected: 0 new failures. `index.ts`'s change from `void runMain(main)` to
`await runMain(main)` is behaviorally equivalent for every existing
success/error path (per this task's own citty trace above) — if any
existing CLI test breaks, that's a real regression to fix, not something
to work around.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/cli/index.ts tests/cli/update-check.test.ts
git commit -m "feat(update): wire the update check into cw's entry point"
```

---

### Task 5: `cw config update-check on/off`

**Files:**
- Modify: `src/cli/commands/config.ts`
- Test: `tests/cli/cli.test.ts` (extend)

**Interfaces:**
- Consumes: `loadGlobalConfig`/`saveGlobalConfig` from Task 1.

**Context:** unlike `trust`/`notify` (workspace-scoped, go through
`withClient`/the daemon RPC), this setting is global and file-based —
`run()` reads/writes `~/.crossweave/config.json` directly, no daemon
connection needed at all.

- [ ] **Step 1: Write the failing test**

Add to `tests/cli/cli.test.ts` (near the existing `config` tests — read
that file first for the exact surrounding style/fixture pattern):

```typescript
it('config update-check on/off toggles global state', async () => {
  const off = await cw(['config', 'update-check', 'off']);
  expect(off.exitCode).toBe(0);
  expect(off.stdout).toContain('off');

  const on = await cw(['config', 'update-check', 'on']);
  expect(on.exitCode).toBe(0);
  expect(on.stdout).toContain('on');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/cli.test.ts -t "update-check"`
Expected: FAIL — subcommand does not exist.

- [ ] **Step 3: Add the subcommand to `src/cli/commands/config.ts`**

```typescript
// add near the top, with the other imports
import { loadGlobalConfig, saveGlobalConfig } from '../../update/global-config.js';

const updateCheckCommand = defineCommand({
  meta: { name: 'update-check', description: 'Enable or disable the background version check' },
  subCommands: {
    on: defineCommand({
      meta: { name: 'on', description: 'Enable the background version check' },
      run() {
        saveGlobalConfig({ ...loadGlobalConfig(), updateCheck: true });
        process.stdout.write('update-check on\n');
      },
    }),
    off: defineCommand({
      meta: { name: 'off', description: 'Disable the background version check' },
      run() {
        saveGlobalConfig({ ...loadGlobalConfig(), updateCheck: false });
        process.stdout.write('update-check off\n');
      },
    }),
  },
});
```

Add `'update-check': updateCheckCommand` to `configCommand`'s
`subCommands` object at the bottom of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/cli.test.ts -t "update-check"`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
bun run typecheck
bun test
git add src/cli/commands/config.ts tests/cli/cli.test.ts
git commit -m "feat(cli): cw config update-check on/off"
```

---

### Task 6: `install.sh`

**Files:**
- Create: `install.sh` (repo root)
- Create: `docs/superpowers/specs/2026-08-14-m7-smoke-test-checklist.md`

**Context:** this is bash, outside `bun test`'s reach (spec §8). No
automated test in this task — instead, a syntax check plus a manual
smoke-test checklist, both real deliverables of this task, not
placeholders for later.

- [ ] **Step 1: Write `install.sh`**

```bash
#!/bin/sh
set -eu

REPO="NMHx2005/crossweave"
INSTALL_DIR="${CW_INSTALL_DIR:-$HOME/.local/bin}"

os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) echo "crossweave: unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
}

arch() {
  case "$(uname -m)" in
    arm64|aarch64)
      if [ "$(os)" = "linux" ]; then
        echo "crossweave: unsupported arch on Linux: $(uname -m) (only linux-x64 is published)" >&2
        exit 1
      fi
      echo arm64 ;;
    x86_64|amd64) echo x64 ;;
    *) echo "crossweave: unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac
}

TARGET="$(os)-$(arch)"
VERSION="${CW_INSTALL_VERSION:-}"

api_url="https://api.github.com/repos/$REPO/releases/latest"
if [ -n "$VERSION" ]; then
  base_url="https://github.com/$REPO/releases/download/$VERSION"
else
  base_url=$(curl -fsSL "$api_url" | grep -o '"browser_download_url": *"[^"]*checksums.txt"' | sed -E 's/.*"(https:[^"]*)checksums.txt"/\1/')
  if [ -z "$base_url" ]; then
    echo "crossweave: could not resolve the latest release" >&2
    exit 1
  fi
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "crossweave: downloading for $TARGET..."
curl -fsSL -o "$tmp/cw" "${base_url}cw-$TARGET"
curl -fsSL -o "$tmp/cwd" "${base_url}cwd-$TARGET"
curl -fsSL -o "$tmp/checksums.txt" "${base_url}checksums.txt"

echo "crossweave: verifying checksums..."
(cd "$tmp" && grep "cw-$TARGET\$" checksums.txt | sha256sum -c -) || {
  echo "crossweave: checksum verification FAILED for cw-$TARGET — aborting, nothing installed" >&2
  exit 1
}
(cd "$tmp" && grep "cwd-$TARGET\$" checksums.txt | sha256sum -c -) || {
  echo "crossweave: checksum verification FAILED for cwd-$TARGET — aborting, nothing installed" >&2
  exit 1
}

mkdir -p "$INSTALL_DIR"
mv "$tmp/cw" "$INSTALL_DIR/cw"
mv "$tmp/cwd" "$INSTALL_DIR/cwd"
chmod +x "$INSTALL_DIR/cw" "$INSTALL_DIR/cwd"

mkdir -p "$HOME/.crossweave"
installed_version="${VERSION:-$("$INSTALL_DIR/cw" --version)}"
printf '{"installedVersion":"%s","updateCheck":true,"lastCheckedAt":null,"lastKnownLatest":null,"lastNotifiedVersion":null}\n' \
  "$installed_version" > "$HOME/.crossweave/config.json"

echo "crossweave: installed to $INSTALL_DIR/cw"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "crossweave: add this to your shell profile: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
```

Note on `install.sh` overwriting `~/.crossweave/config.json` wholesale on
every install: this deliberately resets `updateCheck` to its default
(`true`) on every fresh install/reinstall, which is correct for a first
install but would silently re-enable a user's prior opt-out on a REINSTALL
of the same version. Read the existing file first if present and merge
rather than overwrite, so a reinstall never undoes `cw config
update-check off`:

Revise the config-writing block to:

```bash
mkdir -p "$HOME/.crossweave"
installed_version="${VERSION:-$("$INSTALL_DIR/cw" --version)}"
existing_update_check=true
if [ -f "$HOME/.crossweave/config.json" ]; then
  existing_update_check=$(grep -o '"updateCheck": *[a-z]*' "$HOME/.crossweave/config.json" | grep -o '[a-z]*$' || echo true)
fi
printf '{"installedVersion":"%s","updateCheck":%s,"lastCheckedAt":null,"lastKnownLatest":null,"lastNotifiedVersion":null}\n' \
  "$installed_version" "$existing_update_check" > "$HOME/.crossweave/config.json"
```

- [ ] **Step 2: Syntax-check**

Run: `sh -n install.sh` — expect no output, exit 0. If `shellcheck` is
available (`command -v shellcheck`), also run `shellcheck install.sh` and
fix anything it flags; skip silently if not installed (not a hard
dependency of this project).

- [ ] **Step 3: Write the manual smoke-test checklist**

```markdown
# M7 install.sh — manual smoke-test checklist

Run once against a real release before announcing it, and again any time
`install.sh` itself changes. Not automated (spec §8) — bash driving real
network downloads and a real filesystem install isn't something `bun test`
covers.

- [ ] Fresh macOS (arm64): `curl -fsSL .../install.sh | sh` installs
      cleanly, `cw --version` matches the release tag.
- [ ] Fresh macOS (x64, e.g. Rosetta or an Intel machine): same.
- [ ] Fresh Linux (x64): same.
- [ ] Unsupported arch (e.g. Linux arm64): script exits non-zero with a
      clear message, nothing installed.
- [ ] Deliberately corrupt one byte of a downloaded binary before checksum
      verification runs (or point `checksums.txt` at the wrong file):
      script hard-fails, nothing is moved into `$INSTALL_DIR`.
- [ ] Re-run install after `cw config update-check off`: the reinstalled
      config.json still has `updateCheck: false`, not reset to `true`.
- [ ] `~/.local/bin` not on `PATH`: script prints the export line, doesn't
      silently edit any shell rc file.
```

- [ ] **Step 4: Commit**

```bash
chmod +x install.sh
git add install.sh docs/superpowers/specs/2026-08-14-m7-smoke-test-checklist.md
git commit -m "feat(install): install.sh — curl | sh installer with checksum verification"
```

---

### Task 7: `cw update`

**Files:**
- Create: `src/cli/commands/update.ts`
- Modify: `src/cli/index.ts` (register the command)
- Test: `tests/cli/update-command.test.ts`

**Interfaces:**
- Consumes: `loadGlobalConfig` from Task 1, `DEFAULT_REPO` from
  `src/update/checker.js` (Task 3 already exports it) — import it rather
  than hardcoding the repo string a second time.

**Context:** per spec §5, `cw update` downloads that release's own
`install.sh` + `checksums.txt`, verifies `install.sh` against its
checksum, then runs it with `CW_INSTALL_VERSION` pinned. It does NOT
re-implement the download-verify-install logic in TypeScript — it shells
out to the verified `install.sh`, so there is exactly one implementation
of that logic (spec §5's explicit reasoning).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/update-command.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-update-cmd-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('cw update', () => {
  test('aborts with a clear error when checksum verification fails, installing nothing', async () => {
    // A fake server serving a script and a checksums.txt that does NOT match it —
    // this is the one behavior this task must prove without a real GitHub release:
    // a tampered/corrupted download is refused, never executed.
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('install.sh')) return new Response('#!/bin/sh\necho SHOULD_NOT_RUN\n');
        if (url.pathname.endsWith('checksums.txt')) return new Response('0000000000000000000000000000000000000000000000000000000000000000  install.sh\n');
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const proc = Bun.spawn(
        [process.execPath, CLI, 'update'],
        {
          env: { ...process.env, HOME: home, CW_UPDATE_BASE_URL: `http://127.0.0.1:${server.port}/`, CW_INSTALL_VERSION: 'v0.0.0-test' },
          stdout: 'pipe', stderr: 'pipe',
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      expect(code).not.toBe(0);
      expect(stdout + stderr).not.toContain('SHOULD_NOT_RUN');
      expect((stdout + stderr).toLowerCase()).toContain('checksum');
    } finally {
      server.stop(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/update-command.test.ts`
Expected: FAIL — `cw update` doesn't exist yet.

- [ ] **Step 3: Implement `src/cli/commands/update.ts`**

```typescript
import { defineCommand } from 'citty';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGlobalConfig } from '../../update/global-config.js';
import { DEFAULT_REPO } from '../../update/checker.js';
import { CrossweaveError } from '../../core/errors.js';
import { fail } from '../context.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export const updateCommand = defineCommand({
  meta: { name: 'update', description: "Download and install the latest crossweave release" },
  async run() {
    try {
      const repo = DEFAULT_REPO;
      const cfg = loadGlobalConfig();
      const version = process.env.CW_INSTALL_VERSION ?? cfg.lastKnownLatest;
      if (version === null) {
        process.stdout.write("no newer version known — run any 'cw' command first, or set CW_INSTALL_VERSION\n");
        return;
      }
      const base = process.env.CW_UPDATE_BASE_URL ?? `https://github.com/${repo}/releases/download/${version}/`;

      const tmp = mkdtempSync(join(tmpdir(), 'cw-update-'));
      try {
        const [scriptRes, checksumsRes] = await Promise.all([
          fetch(`${base}install.sh`),
          fetch(`${base}checksums.txt`),
        ]);
        if (!scriptRes.ok || !checksumsRes.ok) {
          throw new CrossweaveError('UPDATE_FETCH_FAILED', `could not download release ${version}`);
        }
        const scriptBuf = Buffer.from(await scriptRes.arrayBuffer());
        const checksums = await checksumsRes.text();
        const line = checksums.split('\n').find((l) => l.trim().endsWith('install.sh'));
        const expected = line?.split(/\s+/)[0];
        const actual = sha256(scriptBuf);
        if (expected === undefined || expected !== actual) {
          throw new CrossweaveError('UPDATE_CHECKSUM_MISMATCH', `install.sh checksum mismatch for ${version} — aborting, nothing changed`);
        }

        const scriptPath = join(tmp, 'install.sh');
        writeFileSync(scriptPath, scriptBuf);
        chmodSync(scriptPath, 0o755);

        const proc = Bun.spawn(['sh', scriptPath], {
          env: { ...process.env, CW_INSTALL_VERSION: version },
          stdout: 'inherit', stderr: 'inherit',
        });
        const code = await proc.exited;
        if (code !== 0) throw new CrossweaveError('UPDATE_INSTALL_FAILED', `install.sh exited with code ${code}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } catch (err) { fail(err); }
  },
});
```

Read `src/cli/context.ts`'s `fail()` first to confirm it exits non-zero on
a thrown `CrossweaveError` (match the existing pattern every other command
in this codebase already uses — don't reinvent error handling here).

- [ ] **Step 4: Register the command in `src/cli/index.ts`**

Add `import { updateCommand } from './commands/update.js';` and
`update: updateCommand,` to `main`'s `subCommands`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/cli/update-command.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
bun run typecheck
bun test
git add src/cli/commands/update.ts src/cli/index.ts tests/cli/update-command.test.ts
git commit -m "feat(cli): cw update — checksum-verified self-update"
```

---

### Task 8: Release pipeline

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `scripts/build.ts`

**Context:** no real tag is pushed in this task (Global Constraints) — the
deliverable is the workflow file and the build script's new flag, verified
by reading them against GitHub Actions' and Bun's own documented syntax
and by running the build script locally for the host target, not by a
live Actions run.

- [ ] **Step 1: Extend `scripts/build.ts` to accept `--target`**

```typescript
import { rm, mkdir } from 'node:fs/promises';

const targetArg = process.argv.find((a) => a.startsWith('--target='))?.split('=')[1];
const suffix = targetArg ? `-${targetArg}` : '';

const targets = [
  { entry: './src/cli/index.ts', out: `./dist/cw${suffix}` },
  { entry: './src/daemon/main.ts', out: `./dist/cwd${suffix}` },
];

await rm('./dist', { recursive: true, force: true });
await mkdir('./dist', { recursive: true });

for (const t of targets) {
  const args = ['bun', 'build', t.entry, '--compile', '--minify', '--outfile', t.out];
  if (targetArg) args.splice(3, 0, `--target=bun-${targetArg}`);
  const proc = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`build failed for ${t.entry}`);
    process.exit(code);
  }
}

console.log(`built ${targets.map((t) => t.out).join(' and ')}`);
```

Verify locally: `bun run scripts/build.ts` (no `--target`, host build)
still produces `dist/cw`/`dist/cwd` exactly as before — this must not
regress the existing dev workflow.

- [ ] **Step 2: Write `.github/workflows/release.yml`**

```yaml
name: release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    strategy:
      matrix:
        target: [darwin-arm64, darwin-x64, linux-x64]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.5
      - run: bun install --frozen-lockfile
      - run: bun run scripts/build.ts --target=${{ matrix.target }}
      - run: |
          mv dist/cw-${{ matrix.target }} cw-${{ matrix.target }}
          mv dist/cwd-${{ matrix.target }} cwd-${{ matrix.target }}
      - uses: actions/upload-artifact@v4
        with:
          name: build-${{ matrix.target }}
          path: |
            cw-${{ matrix.target }}
            cwd-${{ matrix.target }}

  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          pattern: build-*
          merge-multiple: true
      - name: checksums
        run: |
          cp install.sh .
          sha256sum cw-* cwd-* install.sh > checksums.txt
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            cw-*
            cwd-*
            install.sh
            checksums.txt
```

- [ ] **Step 3: Verify the workflow file's syntax**

There's no local GitHub Actions runner in this repo's toolchain — verify
by (a) validating the YAML parses (`bun -e "console.log(require('yaml') ? 'n/a' : '')"`
is not applicable since `yaml` isn't a dependency here; instead use
`python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/release.yml'))"`
if Python+PyYAML is available, or a plain `cat .github/workflows/release.yml`
read-through against GitHub Actions' documented schema if not), and (b)
cross-checking every action version (`actions/checkout@v4`,
`oven-sh/setup-bun@v2`, `actions/upload-artifact@v4`,
`actions/download-artifact@v4`, `softprops/action-gh-release@v2`) is a
real, current major version — do not guess these, check each action's
repo/marketplace listing.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml scripts/build.ts
git commit -m "feat(release): GitHub Actions pipeline — build matrix, checksums, release"
```

---

### Task 9: README install section + final consolidation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the "Install (from source)" section**

```markdown
## Install

```bash
curl -fsSL https://raw.githubusercontent.com/NMHx2005/crossweave/main/install.sh | sh
```

Installs `cw`/`cwd` to `~/.local/bin` for macOS (arm64/x64) and Linux
(x64) — see `install.sh` at the repo root for exactly what it does
(checksum-verified download, no `sudo`, no shell rc file edits).

`cw` checks for a newer version in the background (cached, at most once a
day) and tells you to run `cw update` when one exists — never installs
anything without you running that command. Turn it off with `cw config
update-check off`.

### From source (for crossweave's own development)

```bash
git clone https://github.com/NMHx2005/crossweave crossweave
cd crossweave
bun install
bun run scripts/build.ts   # produces dist/cw and dist/cwd
```
```

Keep everything else in the README (Quickstart, Configuration,
Contributing) as-is — only the Install section changes; Status's "No
installer" bullet also needs removing now that this milestone exists,
replaced with a one-line note that the FIRST real release hasn't been cut
yet (Global Constraints — that's a deliberate follow-up action, not part
of this plan).

- [ ] **Step 2: Update the Status section**

Change:
```markdown
- **No installer.** Today crossweave only runs from a source checkout (see
  Install below). No `curl | sh` script, no package-manager tap, and no
  self-update mechanism exist yet.
```
to:
```markdown
- **No release cut yet.** The installer, release pipeline, and self-update
  check (M7) are built, but the first real GitHub release hasn't been
  tagged — `curl | sh` won't have anything to download until then. Build
  from source in the meantime (see Install below).
```

- [ ] **Step 3: Full verification**

```bash
bun run typecheck
bun test
```
Expected: 0 typecheck errors, full suite green (kill any stray
`dist/cwd`/`src/daemon/main.ts` processes first if `tests/packaging/binary.test.ts`
flakes — this project's well-known sandbox/back-to-back-runs artifact, not
a regression; run `bun test` a second time in isolation if it fails, per
this project's own established pattern).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README install section — real curl|sh command, self-update note"
```
