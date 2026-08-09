# crossweave M0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working session manager: a daemon that owns SQLite state, creates a git worktree per session, launches Claude Code inside it over a PTY, and is driven by a `cw` CLI.

**Architecture:** A long-lived daemon (`cwd`) is the sole owner of `.crossweave/state.db`. The `cw` CLI is a thin client speaking newline-delimited JSON-RPC 2.0 over a unix domain socket, auto-starting the daemon when absent. Domain managers (workspace, session) sit between the RPC method table and the repository layer; the isolation layer wraps `git worktree`; the adapter layer wraps the agent process behind a `AgentAdapter` interface so ACP can slot in at M5 without touching callers.

**Tech Stack:** TypeScript · **Bun 1.3+** · `bun:sqlite` · `Bun.spawn({terminal})` · `bun test` · `simple-git` · `citty`

## Global Constraints

- **Bun >= 1.3.5.** Not Node. Bun supplies the pty (`Bun.spawn({terminal})`), the database (`bun:sqlite`), the test runner (`bun test`) and the bundler (`bun build --compile`) as built-ins. That is what takes the dependency count to two and the native-module count to zero.
- **ZERO native dependencies. Non-negotiable.** This is the security property the runtime was chosen for: with no native module there is no compile-or-download step at install time, so no `postinstall` script ever runs on a user's machine. A dependency that ships a `.node` binary is grounds for rejecting the change, not for adding an exception.
- **Only two runtime dependencies are permitted: `simple-git` and `citty`.** Both are pure JavaScript. Anything else must be built on a Bun or Web standard API.
- **POSIX only for M0 (macOS, Linux).** Bun's pty support is POSIX-only, and the daemon is built on unix domain sockets. `package.json` declares `"os": ["darwin", "linux"]`. Windows is not a V1 target and must not be half-supported.
- **Isolate the three runtime-specific seams** so the runtime stays a reversible decision: the pty behind `AgentAdapter` (Task 7), sqlite behind the repository classes (Tasks 3–4), and the socket behind `node:net` — which Bun implements — rather than `Bun.listen`. Nothing else in the codebase may import a `Bun.*` global.
- **Dependency versions in Task 1's `package.json` were verified against the npm registry on 2026-08-09.** Install exactly what is written. If a package's API has moved and the code in this plan does not compile against it, fix the code and say so in the commit body — do not silently downgrade the dependency to make the plan's code compile unchanged.
- **ESM only.** `"type": "module"`. Relative imports keep their `.js` specifiers throughout — Bun resolves those to the `.ts` sources, and keeping the convention means the code stays valid under a plain `tsc` build if the runtime decision is ever reversed.
- **TypeScript `strict: true`.** No `any` and no `@ts-ignore`, anywhere.
- **Non-null assertions (`!`) are forbidden in `src/` and permitted in `tests/`.** In production code every `!` in this plan was avoidable by narrowing to a local, and they have been rewritten that way. In tests, a `!` that follows an explicit existence assertion is idiomatic and keeps the assertion readable; reviewers must not flag those.
- **All timestamps are ISO 8601 UTC strings** (`new Date().toISOString()`), stored as `TEXT`.
- **Every path originating outside the process is passed through `assertContained` before use.** No exceptions.
- **Tests are deterministic:** no network, no reliance on wall-clock ordering, git fixtures built per test in `fs.mkdtemp` directories and removed in teardown.
- **Package name `crossweave`, binary `cw`, daemon binary `cwd`. License MIT.**
- Commit messages follow Conventional Commits.

## Pre-flight — already completed, do not repeat

Done on 2026-08-09 before execution began. Recorded here so the executing session
starts at Task 1 instead of re-deriving all of it.

**Environment verified on the target machine:**
- Bun 1.3.14 installed via Homebrew (satisfies the >= 1.3.5 floor).
- `bun:sqlite`: `.get()` returns **`null`** for a missing row, `PRAGMA foreign_keys = ON`
  takes effect, and `ON DELETE CASCADE` works. All three were run, not assumed.
- `Bun.spawn({terminal})`: allocates a real TTY (`test -t 1` → `TTY`), `proc.pid` is a
  number, `proc.terminal.write()` exists, `proc.exited` is a promise, and the
  `data(terminal, chunk)` callback delivers output.
- **pty output uses `\r\n`, not `\n`.** Every assertion in this plan uses `.includes()`,
  so none of them need changing — do not "fix" them to compare whole lines.

**Plan conflicts found and ruled on by the human partner:**
- The `!` ban originally applied everywhere while the plan mandated `!` in 11 places.
  Ruling: forbidden in `src/`, permitted in `tests/`. The four `src/` occurrences have
  been rewritten (`MIGRATIONS.slice`, `ownWorktree` local, `instance` local ×2); the
  Global Constraints entry above now states the scoped rule. Reviewers must not flag a
  `!` in a test that follows an existence assertion.
- `expect(after?.lastActiveAt >= row.lastActiveAt)` in Task 4 could not typecheck under
  `strict` (`string | undefined` with `>=`). Rewritten to assert `toBeDefined()` first.

---

### Task 1: Project scaffold and path containment

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/core/errors.ts`
- Create: `src/core/paths.ts`
- Test: `tests/core/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class CrossweaveError extends Error { constructor(code: string, message: string) }` with `readonly code: string`
  - `findProjectRoot(startDir: string): string`
  - `crossweaveDir(projectRoot: string): string`
  - `assertContained(root: string, candidate: string): string`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "crossweave",
  "version": "0.0.0",
  "description": "Make N parallel AI coding agents on one repo safe and mergeable",
  "license": "MIT",
  "type": "module",
  "engines": { "bun": ">=1.3.5" },
  "os": ["darwin", "linux"],
  "bin": { "cw": "./src/cli/index.ts", "cwd": "./src/daemon/main.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "build": "bun build ./src/cli/index.ts --compile --outfile dist/cw",
    "build:daemon": "bun build ./src/daemon/main.ts --compile --outfile dist/cwd"
  },
  "dependencies": {
    "citty": "^0.2.2",
    "simple-git": "^3.36.0"
  },
  "devDependencies": {
    "@types/bun": "^1.3.5",
    "typescript": "^7.0.2"
  }
}
```

Note what is *absent* and must stay absent: no `node-pty`, no `execa`, no `vitest`,
no `better-sqlite3`, no `@types/node`. Bun provides the pty, the subprocess API, the
test runner and the database. `@types/bun` already carries the Node type surface Bun
implements, so adding `@types/node` alongside it only creates conflicting declarations.

`typescript` is `^7`, the native compiler, and is used **only** for `bun run typecheck`.
Bun runs and bundles the TypeScript directly, so there is no `tsc` build step that can
break. If typechecking misbehaves under 7, drop to `typescript@^5.9` and say why in the
commit body.

- [ ] **Step 2: Create `tsconfig.json` and `.gitignore`**

`tsconfig.json` — `noEmit` throughout, since Bun does the running and the bundling:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "preserve",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

`.gitignore`:

```
node_modules/
dist/
.crossweave/
```

- [ ] **Step 3: Install dependencies and confirm the runtime**

Run: `bun --version && bun install`
Expected: version >= 1.3.5; install completes with exactly two packages, **invoking no
compiler and running no postinstall script**. If any dependency triggers a build step,
stop — that breaks the zero-native-dependency constraint this runtime was chosen for.

- [ ] **Step 4: Write the failing test**

Create `tests/core/paths.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { findProjectRoot, crossweaveDir, assertContained } from '../../src/core/paths.js';
import { CrossweaveError } from '../../src/core/errors.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cw-paths-'));
  await $`git init -q -b main`.cwd(root).quiet();
  await writeFile(join(root, 'README.md'), '# fixture\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findProjectRoot', () => {
  it('returns the git root from a nested directory', async () => {
    const nested = join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });
    expect(await realpathEq(findProjectRoot(nested), root)).toBe(true);
  });

  it('throws NOT_A_REPO outside any git repository', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'cw-bare-'));
    try {
      expect(() => findProjectRoot(bare)).toThrowError(
        expect.objectContaining({ code: 'NOT_A_REPO' }) as unknown as Error,
      );
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('crossweaveDir', () => {
  it('appends .crossweave to the project root', () => {
    expect(crossweaveDir('/x/y')).toBe(join('/x/y', '.crossweave'));
  });
});

describe('assertContained', () => {
  it('returns the resolved path for a child', async () => {
    const child = join(root, 'src', 'index.ts');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(child, '');
    expect(await realpathEq(assertContained(root, child), child)).toBe(true);
  });

  it('rejects a traversal escape', () => {
    expect(() => assertContained(root, join(root, '..', 'evil.ts'))).toThrowError(
      expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
    );
  });

  it('rejects a symlink pointing outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cw-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'x');
    const link = join(root, 'link.txt');
    await symlink(join(outside, 'secret.txt'), link);
    try {
      expect(() => assertContained(root, link)).toThrowError(
        expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('accepts a path that does not exist yet but sits under the root', () => {
    const future = join(root, 'not-created-yet', 'file.ts');
    expect(assertContained(root, future)).toContain('not-created-yet');
  });

  // Regression: `existsSync` follows symlinks and reports false for a dangling one,
  // so an earlier implementation skipped the link entirely and let writes escape.
  it('rejects a DANGLING symlink whose target is outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cw-outside-'));
    const link = join(root, 'dangling.txt');
    await symlink(join(outside, 'not-created-yet.txt'), link);
    try {
      expect(() => assertContained(root, link)).toThrowError(
        expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a path under a DANGLING directory symlink pointing outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cw-outside-'));
    const link = join(root, 'dangling-dir');
    await symlink(join(outside, 'no-such-dir'), link);
    try {
      expect(() => assertContained(root, join(link, 'file.ts'))).toThrowError(
        expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlink loop instead of hanging', async () => {
    await symlink(join(root, 'loop-b'), join(root, 'loop-a'));
    await symlink(join(root, 'loop-a'), join(root, 'loop-b'));
    expect(() => assertContained(root, join(root, 'loop-a'))).toThrowError(
      expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
    );
  });

  it('rejects the root itself, so it can gate deletes', () => {
    expect(() => assertContained(root, root)).toThrowError(
      expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
    );
  });

  // Regression: hand-dereferencing a symlink must re-canonicalise the target.
  // `root` here comes from mkdtemp(tmpdir()) and is NOT realpath'd, so on macOS it
  // reads /var/folders/... while its canonical form is /private/var/folders/... .
  // A link storing that raw absolute target used to resolve to a path that no longer
  // shared the canonical root prefix, and a legitimate internal link was rejected.
  it('accepts an internal symlink whose target is absolute but not canonical', async () => {
    const realTarget = join(root, 'real-target');
    await mkdir(realTarget, { recursive: true });
    await symlink(realTarget, join(root, 'internal-link'));
    const resolved = assertContained(root, join(root, 'internal-link', 'file.ts'));
    expect(resolved.endsWith(join('real-target', 'file.ts'))).toBe(true);
  });

  it('accepts an internal symlink with a relative target', async () => {
    await mkdir(join(root, 'rel-target'), { recursive: true });
    await symlink('rel-target', join(root, 'rel-link'));
    const resolved = assertContained(root, join(root, 'rel-link', 'file.ts'));
    expect(resolved.endsWith(join('rel-target', 'file.ts'))).toBe(true);
  });

  it('rejects a multi-hop symlink chain that ultimately lands outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cw-outside-'));
    await writeFile(join(outside, 'real.txt'), 'x');
    await symlink(join(outside, 'real.txt'), join(root, 'hop3'));
    await symlink(join(root, 'hop3'), join(root, 'hop2'));
    await symlink(join(root, 'hop2'), join(root, 'hop1'));
    try {
      expect(() => assertContained(root, join(root, 'hop1'))).toThrowError(
        expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

async function realpathEq(a: string, b: string): Promise<boolean> {
  const { realpathSync } = await import('node:fs');
  return realpathSync(a) === realpathSync(b);
}

it('CrossweaveError carries a code', () => {
  const e = new CrossweaveError('X', 'msg');
  expect(e.code).toBe('X');
  expect(e.message).toBe('msg');
  expect(e).toBeInstanceOf(Error);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bun test tests/core/paths.test.ts`
Expected: FAIL — cannot resolve `../../src/core/paths.js`.

- [ ] **Step 6: Implement `src/core/errors.ts`**

```ts
export class CrossweaveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CrossweaveError';
    this.code = code;
  }
}
```

- [ ] **Step 7: Implement `src/core/paths.ts`**

`assertContained` resolves as far up the chain as actually exists, so it works for
paths that have not been created yet while still defeating symlink escapes.

```ts
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CrossweaveError } from './errors.js';

export function findProjectRoot(startDir: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    throw new CrossweaveError('NOT_A_REPO', `Not inside a git repository: ${startDir}`);
  }
}

export function crossweaveDir(projectRoot: string): string {
  return join(projectRoot, '.crossweave');
}

const MAX_SYMLINK_HOPS = 32;

/**
 * Canonicalise the deepest ancestor of `p` that `realpathSync` can resolve, keeping
 * the remainder lexical.
 *
 * A symlink target is a raw stored string. It may be absolute and recorded through a
 * non-canonical ancestor — on macOS `/var` is itself a symlink to `/private/var`, and
 * `tmpdir()` lives under it, so `join(root, 'x')` is exactly this shape. Substituting
 * such a target without re-canonicalising leaves the walk's cursor non-canonical, and a
 * legitimate *internal* symlink is then rejected because its resolved path no longer
 * shares the canonical root prefix. `realpathSync` throws for a path that does not
 * exist, which is what walks us up to the resolvable part.
 */
function canonicalExistingPrefix(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return join(head, ...tail);
      tail.unshift(head.slice(parent.length + 1));
      head = parent;
    }
  }
}

/**
 * Resolve `candidate` one component at a time, dereferencing symlinks by hand.
 *
 * Why not walk up until `existsSync` is true and `realpathSync` that ancestor:
 * `existsSync` FOLLOWS symlinks, so it reports false for a symlink whose target
 * does not exist yet. A dangling symlink inside the root then looks like a
 * not-yet-created plain component, survives into the returned path unresolved,
 * and every later write follows it straight out of the root. `lstatSync` sees the
 * link itself, and `readlinkSync` reads its target even when that target is absent.
 */
function resolveNoFollow(realRoot: string, candidate: string): string {
  const parts = relative(realRoot, resolve(candidate))
    .split(sep)
    .filter((p) => p !== '' && p !== '.');

  let current = realRoot;
  let hops = 0;

  for (const part of parts) {
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    let next = join(current, part);
    for (;;) {
      let stat;
      try {
        stat = lstatSync(next);
      } catch {
        break; // Component does not exist at all; the rest stays lexical.
      }
      if (!stat.isSymbolicLink()) break;
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        throw new CrossweaveError('PATH_ESCAPE', `Too many symlinks resolving: ${candidate}`);
      }
      const target = readlinkSync(next);
      next = canonicalExistingPrefix(
        isAbsolute(target) ? target : resolve(dirname(next), target),
      );
    }
    current = next;
  }

  return current;
}

/**
 * Returns the resolved path when it lies STRICTLY inside `root`.
 *
 * The root itself is deliberately rejected: callers use this to decide what is
 * safe to write to or delete, and `removeWorktree(root, root)` must not be a
 * legal call. This is a decision, not an accident — `tests/core/paths.test.ts`
 * pins it.
 */
export function assertContained(root: string, candidate: string): string {
  const realRoot = realpathSync(resolve(root));
  const abs = isAbsolute(candidate) ? candidate : join(realRoot, candidate);
  const resolved = resolveNoFollow(realRoot, abs);
  const rel = relative(realRoot, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new CrossweaveError('PATH_ESCAPE', `Path escapes workspace root: ${candidate}`);
  }
  return resolved;
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `bun test tests/core/paths.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock tsconfig.json .gitignore src/core tests/core
git commit -m "feat(core): scaffold project and add path containment guard"
```

---

### Task 2: SQLite open and forward-only migrations

**Files:**
- Create: `src/core/ids.ts`
- Create: `src/db/schema.ts`
- Create: `src/db/open.ts`
- Test: `tests/db/open.test.ts`

**Interfaces:**
- Consumes: `CrossweaveError` from Task 1
- Produces:
  - `newId(prefix: IdPrefix): string` where `type IdPrefix = 'ws' | 's' | 'ev' | 'msg'`
  - `SCHEMA_VERSION: number` (value `1`)
  - `MIGRATIONS: readonly string[]`
  - `openDatabase(dbPath: string): Database`

- [ ] **Step 1: Write the failing test**

Create `tests/db/open.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../../src/db/open.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cw-db-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('openDatabase', () => {
  it('creates the workspace and session tables', () => {
    const db = openDatabase(join(dir, 'state.db'));
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toContain('workspace');
    expect(names).toContain('session');
    db.close();
  });

  it('records the schema version and is idempotent across reopens', () => {
    const p = join(dir, 'state.db');
    openDatabase(p).close();
    const db = openDatabase(p);
    const row = db.prepare('SELECT version FROM schema_meta').get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('enables foreign key enforcement', () => {
    const db = openDatabase(join(dir, 'state.db'));
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });

  it('refuses to open a database newer than this build knows', () => {
    const p = join(dir, 'state.db');
    openDatabase(p).close();
    const raw = new Database(p);
    raw.exec(`UPDATE schema_meta SET version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDatabase(p)).toThrowError(
      expect.objectContaining({ code: 'SCHEMA_TOO_NEW' }) as unknown as Error,
    );
  });
});

describe('openDatabase under concurrency', () => {
  // Regression: two daemons cold-starting at once both died with SQLITE_BUSY before
  // either reached its socket bind, so the auto-start race ended with no winner and
  // both clients timed out. Reproduced at roughly 1 in 10 attempts before the fix.
  // Real processes, not in-process calls — SQLite's locking is per-connection and a
  // single-process test would not exercise it.
  it('survives several processes opening the same fresh database at once', async () => {
    const { fileURLToPath } = await import('node:url');
    const raceDir = await mkdtemp(join(tmpdir(), 'cw-race-'));
    try {
      const dbPath = join(raceDir, '.crossweave', 'state.db');
      const openModule = fileURLToPath(new URL('../../src/db/open.ts', import.meta.url));
      const script =
        `const { openDatabase } = await import(${JSON.stringify(openModule)});` +
        `openDatabase(${JSON.stringify(dbPath)}).close();`;

      const procs = Array.from({ length: 6 }, () =>
        Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' }),
      );
      const results = await Promise.all(
        procs.map(async (p) => ({
          code: await p.exited,
          err: await new Response(p.stderr).text(),
        })),
      );

      const failed = results.filter((r) => r.code !== 0);
      // Surface the real stderr in the failure message rather than a bare count.
      expect(failed.map((f) => f.err).join('\n---\n')).toBe('');
      expect(failed).toHaveLength(0);
    } finally {
      await rm(raceDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('newId', () => {
  it('prefixes the id and stays unique across a tight loop', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('s')));
    expect(ids.size).toBe(1000);
    expect([...ids][0]!.startsWith('s_')).toBe(true);
  });

  it('sorts lexicographically in creation order', () => {
    const a = newId('ws');
    const b = newId('ws');
    expect(a < b).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/open.test.ts`
Expected: FAIL — cannot resolve `../../src/db/open.js`.

- [ ] **Step 3: Implement `src/core/ids.ts`**

Monotonic within a process so ids sort in creation order, which the ledger relies on later.

```ts
import { randomBytes } from 'node:crypto';

export type IdPrefix = 'ws' | 's' | 'ev' | 'msg';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastMs = 0;
let counter = 0;

function encode(value: number, length: number): string {
  let n = value;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

export function newId(prefix: IdPrefix): string {
  const now = Date.now();
  if (now === lastMs) {
    counter += 1;
  } else {
    lastMs = now;
    counter = 0;
  }
  const rand = [...randomBytes(5)].map((b) => ALPHABET[b % 32]).join('');
  return `${prefix}_${encode(now, 10)}${encode(counter, 4)}${rand}`;
}
```

- [ ] **Step 4: Implement `src/db/schema.ts`**

Only the M0 tables. Later milestones append migrations; they never edit these strings.

```ts
export const SCHEMA_VERSION = 1;

/**
 * Each migration is a list of single statements, never one multi-statement blob.
 * Whether a given sqlite binding executes several statements from one `exec` call
 * is exactly the kind of detail that differs between drivers, so the dependency is
 * removed rather than assumed.
 */
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE schema_meta (
    version INTEGER NOT NULL
  )`,
    `CREATE TABLE workspace (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    root_path         TEXT NOT NULL UNIQUE,
    created_at        TEXT NOT NULL,
    default_isolation TEXT NOT NULL CHECK (default_isolation IN ('worktree','shared')),
    safe_mode_tier    TEXT NOT NULL CHECK (safe_mode_tier IN ('T1','T2','T3'))
  )`,
    `CREATE TABLE session (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    agent_kind       TEXT NOT NULL,
    adapter          TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('idle','running','waiting','dead','landed')),
    worktree_path    TEXT,
    branch           TEXT,
    created_at       TEXT NOT NULL,
    last_active_at   TEXT NOT NULL,
    token_budget     INTEGER,
    token_spent      INTEGER NOT NULL DEFAULT 0,
    enforcement_tier TEXT NOT NULL CHECK (enforcement_tier IN ('T1','T2','T3')),
    pid              INTEGER,
    UNIQUE (workspace_id, name)
  )`,
    `CREATE INDEX session_by_workspace ON session (workspace_id, status)`,
  ],
];
```

- [ ] **Step 5: Implement `src/db/open.ts`**

```ts
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CrossweaveError } from '../core/errors.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

export { SCHEMA_VERSION };

export function openDatabase(dbPath: string): Database {
  // 0700 at the source. The database sits beside the daemon socket and holds every
  // session's state, and `mode` on mkdirSync applies only at CREATION — so whichever
  // caller makes the directory first is the one that decides its permissions. The
  // daemon re-chmods defensively for the already-exists case, but a caller that opens
  // the database without starting a daemon (the CLI does) must not leave it open.
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { create: true });

  // Several processes open this file at once — the daemon starting up, and any CLI
  // invocation racing it. Without busy_timeout SQLite fails a contended lock
  // INSTANTLY with SQLITE_BUSY rather than waiting, and switching to WAL needs an
  // exclusive lock. Two cold starts could therefore both die here, before either one
  // reached its socket bind, leaving the auto-start race with no winner at all.
  db.run('PRAGMA busy_timeout = 5000');
  enableWal(db);
  db.run('PRAGMA foreign_keys = ON');

  migrate(db);
  return db;
}

const WAL_SWITCH_ATTEMPTS = 20;
const WAL_SWITCH_DELAY_MS = 25;

/**
 * Synchronous sleep. `openDatabase` is synchronous and this is the only place in the
 * codebase that waits; `Atomics.wait` is the portable way to do it without pulling in
 * a runtime-specific API.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function journalMode(db: Database): string {
  const row = db.query('PRAGMA journal_mode').get() as { journal_mode: string } | null;
  return row?.journal_mode ?? '';
}

/**
 * Switching to WAL takes an exclusive lock, and SQLite answers SQLITE_BUSY for that
 * particular pragma **without honouring busy_timeout** — measured at a ~4% failure
 * rate under six-way contention even with busy_timeout already set.
 *
 * Reading the mode first means the ordinary case never contends at all: only the
 * process that creates the file has to switch anything, and every later opener sees
 * `wal` and returns immediately. The bounded retry exists purely for the creation
 * race, and converges as soon as any one process wins.
 */
function enableWal(db: Database): void {
  for (let attempt = 0; attempt < WAL_SWITCH_ATTEMPTS; attempt += 1) {
    if (journalMode(db) === 'wal') return;
    try {
      db.run('PRAGMA journal_mode = WAL');
      if (journalMode(db) === 'wal') return;
    } catch {
      // Contended: another process is mid-switch. Wait and re-check.
    }
    sleepSync(WAL_SWITCH_DELAY_MS);
  }
  db.close();
  throw new CrossweaveError(
    'DB_WAL_FAILED',
    `Could not switch the database to WAL mode after ${WAL_SWITCH_ATTEMPTS} attempts`,
  );
}

function readVersion(db: Database): number {
  const hasMeta = db
    .query("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get() as { n: number } | null;
  if (hasMeta === null || hasMeta.n === 0) return 0;
  const row = db.query('SELECT version FROM schema_meta').get() as { version: number } | null;
  return row?.version ?? 0;
}

/**
 * Migrate inside BEGIN IMMEDIATE, reading the current version INSIDE that
 * transaction.
 *
 * busy_timeout alone is not enough. Reading the version first and then migrating is
 * a check-then-act: two processes can both observe version 0 and both replay
 * migration 0, and the loser dies on "table schema_meta already exists" rather than
 * on a lock. BEGIN IMMEDIATE takes the write lock up front, so the second process
 * waits, then re-reads a version that is already current and does nothing.
 */
function migrate(db: Database): void {
  try {
    db.run('BEGIN IMMEDIATE');
    const current = readVersion(db);

    if (current > SCHEMA_VERSION) {
      throw new CrossweaveError(
        'SCHEMA_TOO_NEW',
        `Database schema v${current} is newer than this build (v${SCHEMA_VERSION}). Upgrade crossweave.`,
      );
    }

    for (const migration of MIGRATIONS.slice(current, SCHEMA_VERSION)) {
      for (const statement of migration) db.run(statement);
    }

    if (current < SCHEMA_VERSION) {
      db.run('DELETE FROM schema_meta');
      db.query('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION);
    }

    db.run('COMMIT');
  } catch (cause) {
    try {
      db.run('ROLLBACK');
    } catch {
      // BEGIN itself may have failed, leaving nothing to roll back.
    }
    db.close();
    throw cause;
  }
}
```

Two `bun:sqlite` behaviours the rest of the plan relies on: `.get()` returns **`null`**
for no row where `node:sqlite` returned `undefined`, and `.query()` caches the prepared
statement. Every repository in Tasks 3–4 tests the result for truthiness rather than
comparing to `undefined`, so both are handled — do not "fix" those checks into
`=== undefined`.

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test tests/db/open.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/ids.ts src/db tests/db
git commit -m "feat(db): add sqlite open with forward-only migrations and sortable ids"
```

---

### Task 3: Workspace repository

**Files:**
- Create: `src/db/repositories/workspace.ts`
- Test: `tests/db/workspace-repo.test.ts`

**Interfaces:**
- Consumes: `openDatabase` (Task 2), `newId` (Task 2)
- Produces:
  - `interface WorkspaceRow { id: string; name: string; rootPath: string; createdAt: string; defaultIsolation: 'worktree' | 'shared'; safeModeTier: 'T1' | 'T2' | 'T3' }`
  - `class WorkspaceRepo` with `insert(row: WorkspaceRow): void`, `findById(id: string): WorkspaceRow | undefined`, `findByRoot(rootPath: string): WorkspaceRow | undefined`, `findByName(name: string): WorkspaceRow | undefined`, `list(): WorkspaceRow[]`, `delete(id: string): void`

- [ ] **Step 1: Write the failing test**

Create `tests/db/workspace-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo, type WorkspaceRow } from '../../src/db/repositories/workspace.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let repo: WorkspaceRepo;

function makeRow(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: newId('ws'),
    name: 'demo',
    rootPath: '/tmp/demo',
    createdAt: '2026-08-09T00:00:00.000Z',
    defaultIsolation: 'worktree',
    safeModeTier: 'T3',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-wsrepo-'));
  db = openDatabase(join(dir, 'state.db'));
  repo = new WorkspaceRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('WorkspaceRepo', () => {
  it('round-trips a row through insert and findById', () => {
    const row = makeRow();
    repo.insert(row);
    expect(repo.findById(row.id)).toEqual(row);
  });

  it('returns undefined for an unknown id', () => {
    expect(repo.findById('ws_missing')).toBeUndefined();
  });

  it('finds by root path and by name', () => {
    const row = makeRow({ name: 'alpha', rootPath: '/tmp/alpha' });
    repo.insert(row);
    expect(repo.findByRoot('/tmp/alpha')?.id).toBe(row.id);
    expect(repo.findByName('alpha')?.id).toBe(row.id);
  });

  it('lists rows ordered by creation time', () => {
    repo.insert(makeRow({ name: 'b', rootPath: '/tmp/b', createdAt: '2026-08-09T02:00:00.000Z' }));
    repo.insert(makeRow({ name: 'a', rootPath: '/tmp/a', createdAt: '2026-08-09T01:00:00.000Z' }));
    expect(repo.list().map((w) => w.name)).toEqual(['a', 'b']);
  });

  it('rejects a duplicate root path', () => {
    repo.insert(makeRow({ rootPath: '/tmp/same' }));
    expect(() => repo.insert(makeRow({ name: 'other', rootPath: '/tmp/same' }))).toThrow();
  });

  it('deletes a row', () => {
    const row = makeRow();
    repo.insert(row);
    repo.delete(row.id);
    expect(repo.findById(row.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/workspace-repo.test.ts`
Expected: FAIL — cannot resolve `../../src/db/repositories/workspace.js`.

- [ ] **Step 3: Implement `src/db/repositories/workspace.ts`**

```ts
import type { Database } from 'bun:sqlite';

export interface WorkspaceRow {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  defaultIsolation: 'worktree' | 'shared';
  safeModeTier: 'T1' | 'T2' | 'T3';
}

interface WorkspaceRecord {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  default_isolation: string;
  safe_mode_tier: string;
}

function toRow(r: WorkspaceRecord): WorkspaceRow {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    createdAt: r.created_at,
    defaultIsolation: r.default_isolation as WorkspaceRow['defaultIsolation'],
    safeModeTier: r.safe_mode_tier as WorkspaceRow['safeModeTier'],
  };
}

const COLUMNS = 'id, name, root_path, created_at, default_isolation, safe_mode_tier';

export class WorkspaceRepo {
  constructor(private readonly db: Database) {}

  insert(row: WorkspaceRow): void {
    this.db
      .prepare(`INSERT INTO workspace (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.name, row.rootPath, row.createdAt, row.defaultIsolation, row.safeModeTier);
  }

  findById(id: string): WorkspaceRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM workspace WHERE id = ?`).get(id) as
      | WorkspaceRecord
      | null;
    return r ? toRow(r) : undefined;
  }

  findByRoot(rootPath: string): WorkspaceRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM workspace WHERE root_path = ?`).get(rootPath) as
      | WorkspaceRecord
      | null;
    return r ? toRow(r) : undefined;
  }

  findByName(name: string): WorkspaceRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM workspace WHERE name = ?`).get(name) as
      | WorkspaceRecord
      | null;
    return r ? toRow(r) : undefined;
  }

  list(): WorkspaceRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM workspace ORDER BY created_at ASC, id ASC`)
      .all() as WorkspaceRecord[];
    return rows.map(toRow);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workspace WHERE id = ?').run(id);
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/db/workspace-repo.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/workspace.ts tests/db/workspace-repo.test.ts
git commit -m "feat(db): add workspace repository"
```

---

### Task 4: Session repository

**Files:**
- Create: `src/db/repositories/session.ts`
- Test: `tests/db/session-repo.test.ts`

**Interfaces:**
- Consumes: `openDatabase` (Task 2), `WorkspaceRepo` (Task 3)
- Produces:
  - `type SessionStatus = 'idle' | 'running' | 'waiting' | 'dead' | 'landed'`
  - `type EnforcementTier = 'T1' | 'T2' | 'T3'`
  - `interface SessionRow { id: string; workspaceId: string; name: string; agentKind: string; adapter: string; status: SessionStatus; worktreePath: string | null; branch: string | null; createdAt: string; lastActiveAt: string; tokenBudget: number | null; tokenSpent: number; enforcementTier: EnforcementTier; pid: number | null }`
  - `class SessionRepo` with `insert(row: SessionRow): void`, `findById(id: string): SessionRow | undefined`, `findByName(workspaceId: string, name: string): SessionRow | undefined`, `listByWorkspace(workspaceId: string): SessionRow[]`, `listLive(workspaceId: string): SessionRow[]`, `updateStatus(id: string, status: SessionStatus, pid: number | null): void`, `rename(id: string, name: string): void`, `delete(id: string): void`

- [ ] **Step 1: Write the failing test**

Create `tests/db/session-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo, type SessionRow } from '../../src/db/repositories/session.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let repo: SessionRepo;
let workspaceId: string;

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: newId('s'),
    workspaceId,
    name: 'auth',
    agentKind: 'claude',
    adapter: 'claude-pty',
    status: 'idle',
    worktreePath: '/tmp/wt',
    branch: 'cw/auth',
    createdAt: '2026-08-09T00:00:00.000Z',
    lastActiveAt: '2026-08-09T00:00:00.000Z',
    tokenBudget: null,
    tokenSpent: 0,
    enforcementTier: 'T3',
    pid: null,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-srepo-'));
  db = openDatabase(join(dir, 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId,
    name: 'demo',
    rootPath: '/tmp/demo',
    createdAt: '2026-08-09T00:00:00.000Z',
    defaultIsolation: 'worktree',
    safeModeTier: 'T3',
  });
  repo = new SessionRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('SessionRepo', () => {
  it('round-trips a row', () => {
    const row = makeRow();
    repo.insert(row);
    expect(repo.findById(row.id)).toEqual(row);
  });

  it('finds by name within a workspace', () => {
    const row = makeRow({ name: 'tests' });
    repo.insert(row);
    expect(repo.findByName(workspaceId, 'tests')?.id).toBe(row.id);
    expect(repo.findByName(workspaceId, 'nope')).toBeUndefined();
  });

  it('rejects a duplicate name in the same workspace', () => {
    repo.insert(makeRow({ name: 'dup' }));
    expect(() => repo.insert(makeRow({ name: 'dup' }))).toThrow();
  });

  it('updates status and pid together', () => {
    const row = makeRow();
    repo.insert(row);
    repo.updateStatus(row.id, 'running', 4242);
    const after = repo.findById(row.id);
    expect(after).toBeDefined();
    expect(after!.status).toBe('running');
    expect(after!.pid).toBe(4242);
    expect(after!.lastActiveAt >= row.lastActiveAt).toBe(true);
  });

  it('lists only live sessions', () => {
    const a = makeRow({ name: 'a', status: 'running' });
    const b = makeRow({ name: 'b', status: 'dead' });
    const c = makeRow({ name: 'c', status: 'landed' });
    repo.insert(a); repo.insert(b); repo.insert(c);
    expect(repo.listLive(workspaceId).map((s) => s.name)).toEqual(['a']);
  });

  it('renames a session', () => {
    const row = makeRow();
    repo.insert(row);
    repo.rename(row.id, 'renamed');
    expect(repo.findById(row.id)?.name).toBe('renamed');
  });

  it('cascades delete when the workspace is removed', () => {
    const row = makeRow();
    repo.insert(row);
    new WorkspaceRepo(db).delete(workspaceId);
    expect(repo.findById(row.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/session-repo.test.ts`
Expected: FAIL — cannot resolve `../../src/db/repositories/session.js`.

- [ ] **Step 3: Implement `src/db/repositories/session.ts`**

```ts
import type { Database } from 'bun:sqlite';

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'dead' | 'landed';
export type EnforcementTier = 'T1' | 'T2' | 'T3';

export interface SessionRow {
  id: string;
  workspaceId: string;
  name: string;
  agentKind: string;
  adapter: string;
  status: SessionStatus;
  worktreePath: string | null;
  branch: string | null;
  createdAt: string;
  lastActiveAt: string;
  tokenBudget: number | null;
  tokenSpent: number;
  enforcementTier: EnforcementTier;
  pid: number | null;
}

interface SessionRecord {
  id: string;
  workspace_id: string;
  name: string;
  agent_kind: string;
  adapter: string;
  status: string;
  worktree_path: string | null;
  branch: string | null;
  created_at: string;
  last_active_at: string;
  token_budget: number | null;
  token_spent: number;
  enforcement_tier: string;
  pid: number | null;
}

const COLUMNS =
  'id, workspace_id, name, agent_kind, adapter, status, worktree_path, branch, ' +
  'created_at, last_active_at, token_budget, token_spent, enforcement_tier, pid';

const LIVE_STATUSES = ['idle', 'running', 'waiting'] as const;

function toRow(r: SessionRecord): SessionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    agentKind: r.agent_kind,
    adapter: r.adapter,
    status: r.status as SessionStatus,
    worktreePath: r.worktree_path,
    branch: r.branch,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    tokenBudget: r.token_budget,
    tokenSpent: r.token_spent,
    enforcementTier: r.enforcement_tier as EnforcementTier,
    pid: r.pid,
  };
}

export class SessionRepo {
  constructor(private readonly db: Database) {}

  insert(row: SessionRow): void {
    this.db
      .prepare(`INSERT INTO session (${COLUMNS}) VALUES (${'?, '.repeat(13)}?)`)
      .run(
        row.id, row.workspaceId, row.name, row.agentKind, row.adapter, row.status,
        row.worktreePath, row.branch, row.createdAt, row.lastActiveAt,
        row.tokenBudget, row.tokenSpent, row.enforcementTier, row.pid,
      );
  }

  findById(id: string): SessionRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM session WHERE id = ?`).get(id) as
      | SessionRecord
      | null;
    return r ? toRow(r) : undefined;
  }

  findByName(workspaceId: string, name: string): SessionRow | undefined {
    const r = this.db
      .prepare(`SELECT ${COLUMNS} FROM session WHERE workspace_id = ? AND name = ?`)
      .get(workspaceId, name) as SessionRecord | null;
    return r ? toRow(r) : undefined;
  }

  listByWorkspace(workspaceId: string): SessionRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM session WHERE workspace_id = ? ORDER BY created_at ASC, id ASC`)
      .all(workspaceId) as SessionRecord[];
    return rows.map(toRow);
  }

  listLive(workspaceId: string): SessionRow[] {
    const placeholders = LIVE_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM session WHERE workspace_id = ? AND status IN (${placeholders}) ` +
          'ORDER BY created_at ASC, id ASC',
      )
      .all(workspaceId, ...LIVE_STATUSES) as SessionRecord[];
    return rows.map(toRow);
  }

  updateStatus(id: string, status: SessionStatus, pid: number | null): void {
    this.db
      .prepare('UPDATE session SET status = ?, pid = ?, last_active_at = ? WHERE id = ?')
      .run(status, pid, new Date().toISOString(), id);
  }

  rename(id: string, name: string): void {
    this.db.prepare('UPDATE session SET name = ? WHERE id = ?').run(name, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM session WHERE id = ?').run(id);
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/db/session-repo.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/session.ts tests/db/session-repo.test.ts
git commit -m "feat(db): add session repository"
```

---

### Task 5: Git worktree isolation layer

**Files:**
- Create: `src/isolation/worktree.ts`
- Create: `tests/helpers/git-fixture.ts`
- Test: `tests/isolation/worktree.test.ts`

**Interfaces:**
- Consumes: `CrossweaveError` (Task 1), `crossweaveDir` (Task 1)
- Produces:
  - `interface WorktreeHandle { path: string; branch: string }`
  - `createWorktree(projectRoot: string, sessionId: string, branch: string): Promise<WorktreeHandle>`
  - `removeWorktree(projectRoot: string, worktreePath: string): Promise<void>`
  - `listWorktreePaths(projectRoot: string): Promise<string[]>`
  - Test helper: `makeGitFixture(): Promise<{ root: string; cleanup: () => Promise<void> }>`

- [ ] **Step 1: Write the test fixture helper**

Create `tests/helpers/git-fixture.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { $ } from 'bun';

export interface GitFixture {
  root: string;
  cleanup: () => Promise<void>;
}

/** A temp git repo with one commit on `main`. */
export async function makeGitFixture(): Promise<GitFixture> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'cw-git-')));
  await $`git init -q -b main`.cwd(root).quiet();
  await $`git config user.email test@crossweave.dev`.cwd(root).quiet();
  await $`git config user.name ${'crossweave test'}`.cwd(root).quiet();
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await $`git add .`.cwd(root).quiet();
  await $`git commit -q -m init`.cwd(root).quiet();
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/isolation/worktree.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';
import { createWorktree, removeWorktree, listWorktreePaths } from '../../src/isolation/worktree.js';

let fx: GitFixture;
beforeEach(async () => { fx = await makeGitFixture(); });
afterEach(async () => { await fx.cleanup(); });

describe('createWorktree', () => {
  it('creates a worktree under .crossweave/worktrees on a new branch', async () => {
    const h = await createWorktree(fx.root, 's_one', 'cw/one');
    expect(h.path).toBe(join(fx.root, '.crossweave', 'worktrees', 's_one'));
    expect(h.branch).toBe('cw/one');
    expect(existsSync(join(h.path, 'README.md'))).toBe(true);

    const branch = await $`git rev-parse --abbrev-ref HEAD`.cwd(h.path).text();
    expect(branch.trim()).toBe('cw/one');
  });

  it('isolates writes between two worktrees', async () => {
    const a = await createWorktree(fx.root, 's_a', 'cw/a');
    const b = await createWorktree(fx.root, 's_b', 'cw/b');
    const { writeFile, readFile } = await import('node:fs/promises');
    await writeFile(join(a.path, 'only-in-a.txt'), 'a');
    expect(existsSync(join(b.path, 'only-in-a.txt'))).toBe(false);
    expect((await readFile(join(a.path, 'only-in-a.txt'), 'utf8'))).toBe('a');
  });

  it('throws BRANCH_EXISTS when the branch is already taken', async () => {
    await createWorktree(fx.root, 's_one', 'cw/one');
    await expect(createWorktree(fx.root, 's_two', 'cw/one')).rejects.toMatchObject({
      code: 'BRANCH_EXISTS',
    });
  });

  it('throws WORKTREE_FAILED on a repo with no commits', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const empty = await mkdtemp(join(tmpdir(), 'cw-empty-'));
    // Every temp directory this suite creates must be removed. An earlier version of
    // this test leaked one per run; 52 of them accumulated in TMPDIR and the growing
    // directory was a direct cause of the beforeEach hook timeouts elsewhere.
    try {
      await $`git init -q -b main`.cwd(empty).quiet();
      await expect(createWorktree(empty, 's_x', 'cw/x')).rejects.toMatchObject({
        code: 'WORKTREE_FAILED',
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('removeWorktree and listWorktreePaths', () => {
  it('lists then removes a worktree', async () => {
    const h = await createWorktree(fx.root, 's_one', 'cw/one');
    expect(await listWorktreePaths(fx.root)).toContain(h.path);
    await removeWorktree(fx.root, h.path);
    expect(existsSync(h.path)).toBe(false);
    expect(await listWorktreePaths(fx.root)).not.toContain(h.path);
  });

  it('refuses to remove a path outside the project root', async () => {
    await expect(removeWorktree(fx.root, '/tmp')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });

  // Regression: `makeGitFixture` realpaths its root, which hides this. Reaching the
  // same repo through a symlink is the portable way to hand in a non-canonical root —
  // it is the same situation as macOS's /var -> /private/var.
  it('excludes the main worktree even when given a non-canonical root', async () => {
    const { mkdtemp, rm, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const h = await createWorktree(fx.root, 's_one', 'cw/one');
    const linkDir = await mkdtemp(join(tmpdir(), 'cw-alias-'));
    const aliasRoot = join(linkDir, 'alias');
    await symlink(fx.root, aliasRoot);
    try {
      const paths = await listWorktreePaths(aliasRoot);
      expect(paths).toContain(h.path);
      expect(paths).not.toContain(fx.root);
      expect(paths).toHaveLength(1);
    } finally {
      await rm(linkDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/isolation/worktree.test.ts`
Expected: FAIL — cannot resolve `../../src/isolation/worktree.js`.

- [ ] **Step 4: Implement `src/isolation/worktree.ts`**

```ts
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { CrossweaveError } from '../core/errors.js';
import { assertContained, crossweaveDir } from '../core/paths.js';

export interface WorktreeHandle {
  path: string;
  branch: string;
}

function worktreeRoot(projectRoot: string): string {
  return join(crossweaveDir(projectRoot), 'worktrees');
}

export async function createWorktree(
  projectRoot: string,
  sessionId: string,
  branch: string,
): Promise<WorktreeHandle> {
  const path = join(worktreeRoot(projectRoot), sessionId);
  const git = simpleGit(projectRoot);

  const branches = await git.branch();
  if (branches.all.includes(branch)) {
    throw new CrossweaveError('BRANCH_EXISTS', `Branch already exists: ${branch}`);
  }

  // Modern git infers `--orphan` when there is no commit to branch from, so
  // `worktree add` SUCCEEDS on an empty repository. Checking HEAD explicitly is what
  // turns that into the WORKTREE_FAILED the contract promises. Keep it after the
  // branch check so BRANCH_EXISTS still wins on a normal repo.
  try {
    await git.raw(['rev-parse', '--verify', 'HEAD']);
  } catch (cause) {
    throw new CrossweaveError(
      'WORKTREE_FAILED',
      `repository has no commits, cannot create worktree for ${branch}: ${(cause as Error).message}`,
    );
  }

  try {
    await git.raw(['worktree', 'add', '-b', branch, path]);
  } catch (cause) {
    throw new CrossweaveError(
      'WORKTREE_FAILED',
      `git worktree add failed for ${branch}: ${(cause as Error).message}`,
    );
  }

  return { path, branch };
}

export async function removeWorktree(projectRoot: string, worktreePath: string): Promise<void> {
  assertContained(projectRoot, worktreePath);
  const git = simpleGit(projectRoot);
  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } catch (cause) {
    throw new CrossweaveError(
      'WORKTREE_REMOVE_FAILED',
      `git worktree remove failed for ${worktreePath}: ${(cause as Error).message}`,
    );
  }
}

/**
 * Used to unwind a half-created session. `git worktree remove` leaves the branch
 * behind, and a leftover branch makes every retry with the same session name fail
 * with BRANCH_EXISTS — so the branch has to go too.
 */
export async function deleteBranch(projectRoot: string, branch: string): Promise<void> {
  try {
    await simpleGit(projectRoot).raw(['branch', '-D', branch]);
  } catch (cause) {
    throw new CrossweaveError(
      'BRANCH_DELETE_FAILED',
      `git branch -D failed for ${branch}: ${(cause as Error).message}`,
    );
  }
}

export async function listWorktreePaths(projectRoot: string): Promise<string[]> {
  // `git worktree list` always prints CANONICAL paths, but callers may hand us a
  // non-canonical root — on macOS `/var` is a symlink to `/private/var`, and any
  // path round-tripped through config or the database can arrive that way. Comparing
  // raw strings then fails to exclude the main worktree and leaks it into the result.
  const realRoot = realpathSync(projectRoot);
  const out = await simpleGit(projectRoot).raw(['worktree', 'list', '--porcelain']);
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((p) => p !== realRoot);
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/isolation/worktree.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/isolation tests/isolation tests/helpers
git commit -m "feat(isolation): add git worktree create, remove and list"
```

---

### Task 6: Workspace manager

**Files:**
- Create: `src/domain/workspace.ts`
- Test: `tests/domain/workspace.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRepo`, `SessionRepo`, `newId`, `CrossweaveError`, and `realpathSync` from `node:fs`. It does NOT consume `findProjectRoot` — resolving the git root is the caller's job (the daemon does it in Task 10); `init` only normalises whatever root it is handed.
- Produces:
  - `interface WorkspaceInfo { workspace: WorkspaceRow; sessions: SessionRow[] }`
  - `class WorkspaceManager` with constructor `(db: Database)` and methods `init(projectRoot: string, name?: string): WorkspaceRow`, `list(): WorkspaceRow[]`, `info(id: string): WorkspaceInfo`, `resolve(nameOrId: string): WorkspaceRow`, `delete(id: string, opts: { force?: boolean }): void`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/workspace.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { WorkspaceRepo, type WorkspaceRow } from '../../src/db/repositories/workspace.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let mgr: WorkspaceManager;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-wsmgr-'));
  db = openDatabase(join(dir, 'state.db'));
  mgr = new WorkspaceManager(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('WorkspaceManager.init', () => {
  it('defaults the name to the project directory basename', () => {
    const ws = mgr.init('/tmp/projects/my-app');
    expect(ws.name).toBe('my-app');
    expect(ws.rootPath).toBe('/tmp/projects/my-app');
    expect(ws.defaultIsolation).toBe('worktree');
    expect(ws.safeModeTier).toBe('T3');
  });

  it('honours an explicit name', () => {
    expect(mgr.init('/tmp/projects/my-app', 'custom').name).toBe('custom');
  });

  it('is idempotent for the same root', () => {
    const a = mgr.init('/tmp/projects/my-app');
    const b = mgr.init('/tmp/projects/my-app');
    expect(b.id).toBe(a.id);
    expect(mgr.list()).toHaveLength(1);
  });
});

describe('WorkspaceManager.resolve', () => {
  it('resolves by name and by id', () => {
    const ws = mgr.init('/tmp/projects/app', 'alpha');
    expect(mgr.resolve('alpha').id).toBe(ws.id);
    expect(mgr.resolve(ws.id).id).toBe(ws.id);
  });

  it('throws WORKSPACE_NOT_FOUND for an unknown name', () => {
    expect(() => mgr.resolve('ghost')).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_NOT_FOUND' }) as unknown as Error,
    );
  });
});

describe('WorkspaceManager.delete', () => {
  it('refuses while live sessions exist', () => {
    const ws = mgr.init('/tmp/projects/app');
    new SessionRepo(db).insert({
      id: newId('s'), workspaceId: ws.id, name: 'auth', agentKind: 'claude',
      adapter: 'claude-pty', status: 'running', worktreePath: null, branch: null,
      createdAt: '2026-08-09T00:00:00.000Z', lastActiveAt: '2026-08-09T00:00:00.000Z',
      tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
    expect(() => mgr.delete(ws.id, {})).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_HAS_LIVE_SESSIONS' }) as unknown as Error,
    );
    expect(mgr.list()).toHaveLength(1);
  });

  it('deletes with force even when live sessions exist', () => {
    const ws = mgr.init('/tmp/projects/app');
    new SessionRepo(db).insert({
      id: newId('s'), workspaceId: ws.id, name: 'auth', agentKind: 'claude',
      adapter: 'claude-pty', status: 'running', worktreePath: null, branch: null,
      createdAt: '2026-08-09T00:00:00.000Z', lastActiveAt: '2026-08-09T00:00:00.000Z',
      tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
    mgr.delete(ws.id, { force: true });
    expect(mgr.list()).toHaveLength(0);
  });

  it('deletes cleanly when no sessions are live', () => {
    const ws = mgr.init('/tmp/projects/app');
    mgr.delete(ws.id, {});
    expect(mgr.list()).toHaveLength(0);
  });
});

describe('WorkspaceManager.info', () => {
  it('returns the workspace with its sessions', () => {
    const ws = mgr.init('/tmp/projects/app');
    expect(mgr.info(ws.id)).toEqual({ workspace: ws, sessions: [] });
  });
});

describe('WorkspaceManager identity and ambiguity', () => {
  // Regression: root_path is a workspace's identity, so it must be compared in one
  // spelling. Reaching the same directory through a symlink used to create a second
  // workspace for it.
  it('treats a symlinked root as the same workspace', async () => {
    const real = await mkdtemp(join(tmpdir(), 'cw-real-'));
    const linkDir = await mkdtemp(join(tmpdir(), 'cw-link-'));
    const alias = join(linkDir, 'alias');
    await symlink(real, alias);
    try {
      const a = mgr.init(real);
      const b = mgr.init(alias);
      expect(b.id).toBe(a.id);
      expect(mgr.list()).toHaveLength(1);
    } finally {
      await rm(real, { recursive: true, force: true });
      await rm(linkDir, { recursive: true, force: true });
    }
  });

  it('leaves a path that does not exist exactly as given', () => {
    expect(mgr.init('/tmp/projects/never-created').rootPath).toBe('/tmp/projects/never-created');
  });

  it('returns the existing row and ignores a different name for the same root', () => {
    const first = mgr.init('/tmp/projects/app', 'original');
    const second = mgr.init('/tmp/projects/app', 'renamed');
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('original');
  });

  // Regression: a concurrent writer between init's read and its write used to
  // surface a raw SQLiteError naming a table column. Stubbing findByRoot to miss
  // once reproduces exactly that window.
  it('returns the winner when a concurrent writer takes the root first', () => {
    const root = '/tmp/projects/raced';
    new WorkspaceRepo(db).insert({
      id: newId('ws'), name: 'winner', rootPath: root,
      createdAt: '2026-08-09T00:00:00.000Z',
      defaultIsolation: 'worktree', safeModeTier: 'T3',
    });

    const internals = mgr as unknown as { workspaces: WorkspaceRepo };
    const real = internals.workspaces.findByRoot.bind(internals.workspaces);
    let missed = false;
    internals.workspaces.findByRoot = (p: string): WorkspaceRow | undefined => {
      if (!missed) { missed = true; return undefined; }
      return real(p);
    };

    expect(mgr.init(root, 'loser').name).toBe('winner');
  });

  it('refuses to resolve an ambiguous name instead of guessing', () => {
    mgr.init('/tmp/projects/one', 'shared');
    mgr.init('/tmp/projects/two', 'shared');
    expect(() => mgr.resolve('shared')).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_NAME_AMBIGUOUS' }) as unknown as Error,
    );
  });

  it('still resolves a unique name, and id always wins', () => {
    const only = mgr.init('/tmp/projects/solo', 'solo');
    expect(mgr.resolve('solo').id).toBe(only.id);
    expect(mgr.resolve(only.id).id).toBe(only.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/domain/workspace.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/workspace.js`.

- [ ] **Step 3: Implement `src/domain/workspace.ts`**

```ts
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { WorkspaceRepo, type WorkspaceRow } from '../db/repositories/workspace.js';
import { SessionRepo, type SessionRow } from '../db/repositories/session.js';

export interface WorkspaceInfo {
  workspace: WorkspaceRow;
  sessions: SessionRow[];
}

export class WorkspaceManager {
  private readonly workspaces: WorkspaceRepo;
  private readonly sessions: SessionRepo;

  constructor(db: Database) {
    this.workspaces = new WorkspaceRepo(db);
    this.sessions = new SessionRepo(db);
  }

  /**
   * `root_path` is the identity of a workspace, so it has to be compared in one
   * spelling. A path that exists on disk gets canonicalised; one that does not cannot
   * be a symlink alias for anything, so it is used as written — which is also what
   * keeps this function filesystem-free for callers that pass a path that is not
   * there yet.
   */
  private static canonicalRoot(projectRoot: string): string {
    try {
      return realpathSync(projectRoot);
    } catch {
      return projectRoot;
    }
  }

  /**
   * Idempotent for a given root. Passing a different `name` for a root that already
   * exists returns the existing row unchanged rather than renaming it — rename is
   * `workspace rename`'s job, not init's.
   */
  init(projectRoot: string, name?: string): WorkspaceRow {
    const root = WorkspaceManager.canonicalRoot(projectRoot);
    const existing = this.workspaces.findByRoot(root);
    if (existing) return existing;

    const row: WorkspaceRow = {
      id: newId('ws'),
      name: name ?? basename(root),
      rootPath: root,
      createdAt: new Date().toISOString(),
      defaultIsolation: 'worktree',
      safeModeTier: 'T3',
    };

    try {
      this.workspaces.insert(row);
    } catch (cause) {
      // Another process inserted this root between our read and our write. The
      // UNIQUE constraint on root_path is what makes that safe to recover from;
      // without this the caller would get a raw SQLiteError naming a table column.
      const raced = this.workspaces.findByRoot(root);
      if (raced) return raced;
      throw new CrossweaveError(
        'WORKSPACE_INIT_FAILED',
        `Could not create workspace at ${root}: ${(cause as Error).message}`,
      );
    }
    return row;
  }

  list(): WorkspaceRow[] {
    return this.workspaces.list();
  }

  /**
   * Id wins over name. Names are NOT unique in the schema, and `delete` is built on
   * this — silently picking the first of several same-named workspaces would delete
   * one the caller did not mean. Ambiguity therefore fails closed and demands an id.
   */
  resolve(nameOrId: string): WorkspaceRow {
    const byId = this.workspaces.findById(nameOrId);
    if (byId) return byId;

    const byName = this.workspaces.list().filter((w) => w.name === nameOrId);
    if (byName.length > 1) {
      throw new CrossweaveError(
        'WORKSPACE_NAME_AMBIGUOUS',
        `${byName.length} workspaces are named ${nameOrId}: ` +
          `${byName.map((w) => `${w.id} (${w.rootPath})`).join(', ')}. Use the id instead.`,
      );
    }

    const found = byName[0];
    if (!found) {
      throw new CrossweaveError('WORKSPACE_NOT_FOUND', `No such workspace: ${nameOrId}`);
    }
    return found;
  }

  info(id: string): WorkspaceInfo {
    const workspace = this.resolve(id);
    return { workspace, sessions: this.sessions.listByWorkspace(workspace.id) };
  }

  delete(id: string, opts: { force?: boolean }): void {
    const workspace = this.resolve(id);
    const live = this.sessions.listLive(workspace.id);
    if (live.length > 0 && !opts.force) {
      throw new CrossweaveError(
        'WORKSPACE_HAS_LIVE_SESSIONS',
        `Workspace ${workspace.name} still has ${live.length} live session(s): ` +
          `${live.map((s) => s.name).join(', ')}. Kill them first or pass --force.`,
      );
    }
    this.workspaces.delete(workspace.id);
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/domain/workspace.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/domain/workspace.ts tests/domain/workspace.test.ts
git commit -m "feat(domain): add workspace manager with live-session delete guard"
```

---

### Task 7: Agent adapter interface and Claude Code PTY adapter

**Files:**
- Create: `src/adapters/types.ts`
- Create: `src/adapters/claude-pty.ts`
- Create: `src/adapters/registry.ts`
- Test: `tests/adapters/claude-pty.test.ts`

**Interfaces:**
- Consumes: `CrossweaveError` (Task 1), `EnforcementTier` (Task 4)
- Produces:
  - `interface SpawnOptions { cwd: string; env: Record<string, string>; cols: number; rows: number }`
  - `interface AgentProcess { readonly pid: number; onData(cb: (chunk: string) => void): void; onExit(cb: (code: number) => void): void; write(data: string): void; resize(cols: number, rows: number): void; kill(signal?: NodeJS.Signals): void }`
  - `interface AgentAdapter { readonly kind: string; readonly enforcementTier: EnforcementTier; spawn(opts: SpawnOptions): AgentProcess }`
  - `class ClaudePtyAdapter implements AgentAdapter` with constructor `(command?: string, args?: string[])`
  - `createAdapter(kind: string): AgentAdapter`

The adapter takes its command through the constructor precisely so tests can drive
it with `sh` instead of the real `claude` binary — the tests must never depend on
Claude Code being installed.

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/claude-pty.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ClaudePtyAdapter } from '../../src/adapters/claude-pty.js';
import { createAdapter } from '../../src/adapters/registry.js';

function collect(proc: { onData(cb: (c: string) => void): void }): () => string {
  let buf = '';
  proc.onData((c) => { buf += c; });
  return () => buf;
}

describe('ClaudePtyAdapter', () => {
  it('reports kind and enforcement tier T3', () => {
    const a = new ClaudePtyAdapter();
    expect(a.kind).toBe('claude');
    expect(a.enforcementTier).toBe('T3');
  });

  // Assert on the directory's unique basename, never on a substring of the temp path.
  // `tmpdir()` is `/private/var/folders/…/T` on macOS and contains no "tmp" at all.
  it('spawns a process in the requested cwd and streams its output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-adapter-'));
    try {
      const adapter = new ClaudePtyAdapter('sh', ['-c', 'pwd']);
      const proc = adapter.spawn({ cwd: dir, env: {}, cols: 80, rows: 24 });
      const read = collect(proc);
      const code = await new Promise<number>((res) => proc.onExit(res));
      expect(code).toBe(0);
      expect(read()).toContain(basename(dir));
      expect(proc.pid).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allocates a real tty so the child sees an interactive terminal', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'test -t 1 && echo TTY || echo NOTTY']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    await new Promise<number>((res) => proc.onExit(res));
    expect(read()).toContain('TTY');
  });

  it('forwards stdin to the child', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'read line; echo "got:$line"']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('hello\n');
    await new Promise<number>((res) => proc.onExit(res));
    expect(read()).toContain('got:hello');
  });

  it('injects the provided env', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'echo "v=$CW_TEST"']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: { CW_TEST: 'ok' }, cols: 80, rows: 24 });
    const read = collect(proc);
    await new Promise<number>((res) => proc.onExit(res));
    expect(read()).toContain('v=ok');
  });

  it('kills a long-running child', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'sleep 60']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    const exited = new Promise<number>((res) => proc.onExit(res));
    proc.kill('SIGKILL');
    await expect(exited).resolves.toBeTypeOf('number');
  });

  // Task 13 fans this stream out to every client attached to a session. One broken
  // viewer must not be able to starve the others, and a bare for-loop over the
  // listeners does exactly that — permanently, since the same subscriber throws on
  // every later chunk too.
  it('keeps delivering data to the other listeners when one throws', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'echo one; echo two']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    const seen: string[] = [];
    proc.onData(() => { seen.push('first'); });
    proc.onData(() => { throw new Error('bad subscriber'); });
    proc.onData(() => { seen.push('third'); });
    await new Promise<number>((res) => proc.onExit(res));
    expect(seen).toContain('first');
    expect(seen).toContain('third');
  });

  it('keeps calling the other exit listeners when one throws', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'exit 0']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    const seen: string[] = [];
    proc.onExit(() => { seen.push('first'); });
    proc.onExit(() => { throw new Error('bad subscriber'); });
    await new Promise<void>((res) => proc.onExit(() => { seen.push('third'); res(); }));
    expect(seen).toEqual(['first', 'third']);
  });

  // Pins a contract Task 13 depends on: the adapter buffers NOTHING, so anything
  // emitted before a subscriber attaches is gone. Scrollback is the session
  // runtime's job, not the adapter's. Synchronises on the data itself rather than a
  // timer so the test stays deterministic.
  it('does not buffer output for a listener that attaches later', async () => {
    const adapter = new ClaudePtyAdapter('sh', ['-c', 'echo early; read x; echo late']);
    const proc = adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    await new Promise<void>((res) => {
      proc.onData((c) => { if (c.includes('early')) res(); });
    });
    const late: string[] = [];
    proc.onData((c) => { late.push(c); });
    proc.write('go\n');
    await new Promise<number>((res) => proc.onExit(res));
    expect(late.join('')).not.toContain('early');
    expect(late.join('')).toContain('late');
  });
});

describe('createAdapter', () => {
  it('returns the claude adapter', () => {
    expect(createAdapter('claude').kind).toBe('claude');
    expect(createAdapter('claude').enforcementTier).toBe('T3');
  });

  it('throws UNKNOWN_AGENT for an unsupported kind', () => {
    expect(() => createAdapter('cursor')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_AGENT' }) as unknown as Error,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/adapters/claude-pty.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/claude-pty.js`.

- [ ] **Step 3: Implement `src/adapters/types.ts`**

```ts
import type { EnforcementTier } from '../db/repositories/session.js';

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface AgentProcess {
  readonly pid: number;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface AgentAdapter {
  readonly kind: string;
  readonly enforcementTier: EnforcementTier;
  spawn(opts: SpawnOptions): AgentProcess;
}
```

- [ ] **Step 4: Implement `src/adapters/claude-pty.ts`**

Two shape mismatches between `Bun.spawn`'s pty and the `AgentProcess` interface have
to be bridged here, and this is the only file allowed to know about either:

1. Bun takes **one** `data(terminal, chunk)` callback fixed at spawn time, while
   `AgentProcess.onData` lets callers subscribe later and more than once. The class
   below fans out to a listener list.
2. Bun signals exit through the `proc.exited` **promise**, not a callback.

```ts
import type { EnforcementTier } from '../db/repositories/session.js';
import type { AgentAdapter, AgentProcess, SpawnOptions } from './types.js';

type BunTerminal = { write(data: string): void; resize(cols: number, rows: number): void; close(): void };
type BunPtyProcess = { pid: number; exited: Promise<number>; terminal: BunTerminal; kill(signal?: number | NodeJS.Signals): void };

/**
 * Deliver to every listener even when one of them throws.
 *
 * A bare `for (const cb of listeners) cb(v)` aborts on the first throw, so every
 * listener registered after the bad one stops receiving anything — and because the
 * same subscriber throws on every subsequent emit, it never recovers. Task 13 fans
 * this out to several attached clients at once, where one broken viewer must not be
 * able to starve the rest.
 *
 * The error is swallowed rather than logged because M0 has nowhere to log it. M2
 * adds the event ledger; subscriber failures belong there.
 */
function fanOut<T>(listeners: ReadonlyArray<(value: T) => void>, value: T): void {
  for (const cb of listeners) {
    try {
      cb(value);
    } catch {
      // The subscriber owns its own failure; the stream keeps going.
    }
  }
}

class PtyProcess implements AgentProcess {
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number) => void> = [];
  private exitCode: number | null = null;

  constructor(private readonly proc: BunPtyProcess) {
    void proc.exited.then((code) => {
      this.exitCode = code;
      fanOut(this.exitListeners, code);
    });
  }

  /** Called by the adapter from Bun's single spawn-time data callback. */
  emit(chunk: string): void {
    fanOut(this.dataListeners, chunk);
  }

  get pid(): number {
    return this.proc.pid;
  }

  onData(cb: (chunk: string) => void): void {
    this.dataListeners.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    // A listener registered after the process already exited must still fire.
    if (this.exitCode !== null) cb(this.exitCode);
    else this.exitListeners.push(cb);
  }

  write(data: string): void {
    this.proc.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    this.proc.terminal.resize(cols, rows);
  }

  kill(signal?: NodeJS.Signals): void {
    this.proc.kill(signal);
  }
}

/**
 * Tier T3: an opaque CLI driven over a pty. crossweave observes output but
 * cannot intercept tool calls, so Safe Mode here is advisory only (spec §2.1).
 */
export class ClaudePtyAdapter implements AgentAdapter {
  readonly kind = 'claude';
  readonly enforcementTier: EnforcementTier = 'T3';

  constructor(
    private readonly command = 'claude',
    private readonly args: string[] = [],
  ) {}

  spawn(opts: SpawnOptions): AgentProcess {
    let wrapper: PtyProcess | undefined;

    const proc = Bun.spawn([this.command, ...this.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, TERM: 'xterm-256color' },
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        data(_terminal: unknown, chunk: string | Uint8Array) {
          const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          wrapper?.emit(text);
        },
      },
    }) as unknown as BunPtyProcess;

    wrapper = new PtyProcess(proc);
    return wrapper;
  }
}
```

The `wrapper` is assigned after `Bun.spawn` returns but the `data` callback only fires
on the event loop, so it is always defined by the time a chunk arrives. The `?.` is
there for the pathological case, not as a routine path.

`createAdapter` deliberately lives only in `registry.ts`. Re-exporting it from here
would create an import cycle, since the registry imports this class.

- [ ] **Step 5: Implement `src/adapters/registry.ts`**

```ts
import { CrossweaveError } from '../core/errors.js';
import { ClaudePtyAdapter } from './claude-pty.js';
import type { AgentAdapter } from './types.js';

/** M5 registers the ACP client and Cursor here. M0 supports Claude Code only. */
export function createAdapter(kind: string): AgentAdapter {
  if (kind === 'claude') return new ClaudePtyAdapter();
  throw new CrossweaveError(
    'UNKNOWN_AGENT',
    `Unsupported agent kind: ${kind}. M0 supports: claude`,
  );
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test tests/adapters/claude-pty.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add src/adapters tests/adapters
git commit -m "feat(adapters): add agent adapter interface and Claude Code pty adapter"
```

---

### Task 8: Session manager

**Files:**
- Create: `src/domain/session.ts`
- Modify: `src/isolation/worktree.ts` — add `deleteBranch`, needed to unwind a half-created session
- Test: `tests/domain/session.test.ts`

**Interfaces:**
- Consumes: `SessionRepo` (Task 4), `WorkspaceRepo` (Task 3), `createWorktree` / `removeWorktree` (Task 5), `createAdapter` (Task 7)
- Produces:
  - `interface CreateSessionOptions { workspaceId: string; name: string; agent: string; worktree: boolean }`
  - `class SessionManager` with constructor `(db: Database)` and methods `create(opts: CreateSessionOptions): Promise<SessionRow>`, `list(workspaceId: string): SessionRow[]`, `resolve(workspaceId: string, idOrName: string): SessionRow`, `rename(workspaceId: string, idOrName: string, newName: string): SessionRow`, `kill(workspaceId: string, idOrName: string, opts: { removeWorktree: boolean }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/session.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { listWorktreePaths } from '../../src/isolation/worktree.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let sessions: SessionManager;
let workspaceId: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = new WorkspaceManager(db).init(fx.root).id;
  sessions = new SessionManager(db);
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('SessionManager.create', () => {
  it('creates a worktree and records the session as idle', async () => {
    const s = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    expect(s.status).toBe('idle');
    expect(s.branch).toBe('cw/auth');
    expect(s.adapter).toBe('claude');
    expect(s.enforcementTier).toBe('T3');
    expect(s.worktreePath).not.toBeNull();
    expect(existsSync(join(s.worktreePath!, 'README.md'))).toBe(true);
  });

  it('shares the project root when worktree is false', async () => {
    const s = await sessions.create({ workspaceId, name: 'shared', agent: 'claude', worktree: false });
    expect(s.worktreePath).toBe(fx.root);
    expect(s.branch).toBeNull();
  });

  it('rejects a duplicate session name', async () => {
    await sessions.create({ workspaceId, name: 'dup', agent: 'claude', worktree: true });
    await expect(
      sessions.create({ workspaceId, name: 'dup', agent: 'claude', worktree: true }),
    ).rejects.toMatchObject({ code: 'SESSION_NAME_TAKEN' });
  });

  it('rejects an unknown agent before creating a worktree', async () => {
    await expect(
      sessions.create({ workspaceId, name: 'x', agent: 'cursor', worktree: true }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_AGENT' });
    expect(sessions.list(workspaceId)).toHaveLength(0);
  });

  it('leaves no orphan row when worktree creation fails', async () => {
    await sessions.create({ workspaceId, name: 'first', agent: 'claude', worktree: true });
    // cw/second is free, but pre-creating the branch forces BRANCH_EXISTS.
    const { simpleGit } = await import('simple-git');
    await simpleGit(fx.root).raw(['branch', 'cw/second']);
    await expect(
      sessions.create({ workspaceId, name: 'second', agent: 'claude', worktree: true }),
    ).rejects.toMatchObject({ code: 'BRANCH_EXISTS' });
    expect(sessions.list(workspaceId).map((s) => s.name)).toEqual(['first']);
  });
});

describe('SessionManager.resolve and rename', () => {
  it('resolves by name and by id', async () => {
    const s = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    expect(sessions.resolve(workspaceId, 'auth').id).toBe(s.id);
    expect(sessions.resolve(workspaceId, s.id).id).toBe(s.id);
  });

  it('throws SESSION_NOT_FOUND for an unknown handle', () => {
    expect(() => sessions.resolve(workspaceId, 'ghost')).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' }) as unknown as Error,
    );
  });

  it('renames and rejects a name collision', async () => {
    await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: true });
    expect(sessions.rename(workspaceId, b.id, 'c').name).toBe('c');
    expect(() => sessions.rename(workspaceId, 'c', 'a')).toThrowError(
      expect.objectContaining({ code: 'SESSION_NAME_TAKEN' }) as unknown as Error,
    );
  });

  it('lets a session keep the name it already has', async () => {
    await sessions.create({ workspaceId, name: 'same', agent: 'claude', worktree: true });
    expect(sessions.rename(workspaceId, 'same', 'same').name).toBe('same');
  });
});

describe('SessionManager session name validation', () => {
  // Regression: names went straight into `cw/<name>` as a git branch. Git rejected
  // them downstream and its own multi-line stderr reached the terminal as several
  // lines with no CODE: prefix.
  const rejected = ['has space', 'has\ttab', 'has\nnewline', '-leading-dash', '', 'a'.repeat(65), 'sl/ash', 'dot.ted'];
  for (const name of rejected) {
    it(`rejects ${JSON.stringify(name)} before it reaches git`, async () => {
      await expect(
        sessions.create({ workspaceId, name, agent: 'claude', worktree: true }),
      ).rejects.toMatchObject({ code: 'INVALID_SESSION_NAME' });
      expect(sessions.list(workspaceId)).toHaveLength(0);
    });
  }

  it('accepts ordinary names', async () => {
    for (const name of ['auth', 'feature-1', 'API_v2', 'a']) {
      const s = await sessions.create({ workspaceId, name, agent: 'claude', worktree: true });
      expect(s.name).toBe(name);
    }
  });

  it('validates on rename too', async () => {
    await sessions.create({ workspaceId, name: 'ok', agent: 'claude', worktree: true });
    expect(() => sessions.rename(workspaceId, 'ok', 'not ok')).toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION_NAME' }) as unknown as Error,
    );
    expect(sessions.resolve(workspaceId, 'ok').name).toBe('ok');
  });
});

describe('SessionManager.create unwinds a half-created session', () => {
  // The row is the only thing that makes a worktree reachable. Without unwinding, a
  // failed insert strands a full checkout on disk AND leaves the branch, so the same
  // session name can never be created again.
  it('removes the worktree and the branch when the row insert fails', async () => {
    const { simpleGit } = await import('simple-git');
    const original = SessionRepo.prototype.insert;
    SessionRepo.prototype.insert = (): void => {
      throw new Error('simulated insert failure');
    };
    try {
      await expect(
        sessions.create({ workspaceId, name: 'doomed', agent: 'claude', worktree: true }),
      ).rejects.toThrow('simulated insert failure');
    } finally {
      SessionRepo.prototype.insert = original;
    }

    expect(sessions.list(workspaceId)).toHaveLength(0);
    expect(await listWorktreePaths(fx.root)).toHaveLength(0);
    expect((await simpleGit(fx.root).branch()).all).not.toContain('cw/doomed');

    // The real damage was that the name became permanently unusable. Prove it is not.
    const retry = await sessions.create({
      workspaceId, name: 'doomed', agent: 'claude', worktree: true,
    });
    expect(retry.branch).toBe('cw/doomed');
  });
});

describe('SessionManager.kill', () => {
  it('marks the session dead and keeps the worktree by default', async () => {
    const s = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'auth', { removeWorktree: false });
    expect(sessions.resolve(workspaceId, 'auth').status).toBe('dead');
    expect(existsSync(s.worktreePath!)).toBe(true);
  });

  it('removes the worktree when asked', async () => {
    const s = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'auth', { removeWorktree: true });
    expect(existsSync(s.worktreePath!)).toBe(false);
    expect(sessions.resolve(workspaceId, 'auth').worktreePath).toBeNull();
  });

  it('never removes the project root for a shared session', async () => {
    await sessions.create({ workspaceId, name: 'shared', agent: 'claude', worktree: false });
    await sessions.kill(workspaceId, 'shared', { removeWorktree: true });
    expect(existsSync(fx.root)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/domain/session.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/session.js`.

- [ ] **Step 3: Implement `src/domain/session.ts`**

Ordering matters: the agent kind is validated and the worktree is created
*before* the row is inserted, so a failure can never leave an orphan session row.

```ts
import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { WorkspaceRepo } from '../db/repositories/workspace.js';
import { SessionRepo, type SessionRow } from '../db/repositories/session.js';
import { createWorktree, deleteBranch, removeWorktree } from '../isolation/worktree.js';
import { createAdapter } from '../adapters/registry.js';

export interface CreateSessionOptions {
  workspaceId: string;
  name: string;
  agent: string;
  worktree: boolean;
}

/**
 * A session name becomes a git branch (`cw/<name>`) and a column in a tab-delimited
 * listing the TUI parses. Letting an arbitrary string through means git rejects it
 * downstream and its own multi-line stderr surfaces as several lines with no `CODE:`
 * prefix, which breaks the CLI's one parseable-error contract. Dots are excluded
 * rather than special-cased: `..` and a trailing `.lock` are both invalid refs, and
 * no realistic session name needs one.
 */
const VALID_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_SESSION_NAME = 64;

function assertValidSessionName(name: string): void {
  if (name.length > MAX_SESSION_NAME || !VALID_SESSION_NAME.test(name)) {
    throw new CrossweaveError(
      'INVALID_SESSION_NAME',
      `Session name must be 1-${MAX_SESSION_NAME} characters of letters, digits, ` +
        `dash or underscore and start with a letter or digit, got ${JSON.stringify(name)}`,
    );
  }
}

export class SessionManager {
  private readonly sessions: SessionRepo;
  private readonly workspaces: WorkspaceRepo;

  constructor(db: Database) {
    this.sessions = new SessionRepo(db);
    this.workspaces = new WorkspaceRepo(db);
  }

  private projectRoot(workspaceId: string): string {
    const ws = this.workspaces.findById(workspaceId);
    if (!ws) throw new CrossweaveError('WORKSPACE_NOT_FOUND', `No such workspace: ${workspaceId}`);
    return ws.rootPath;
  }

  async create(opts: CreateSessionOptions): Promise<SessionRow> {
    assertValidSessionName(opts.name);
    const root = this.projectRoot(opts.workspaceId);

    if (this.sessions.findByName(opts.workspaceId, opts.name)) {
      throw new CrossweaveError('SESSION_NAME_TAKEN', `Session already exists: ${opts.name}`);
    }

    const adapter = createAdapter(opts.agent);
    const id = newId('s');

    let worktreePath = root;
    let branch: string | null = null;
    if (opts.worktree) {
      const handle = await createWorktree(root, id, `cw/${opts.name}`);
      worktreePath = handle.path;
      branch = handle.branch;
    }

    const now = new Date().toISOString();
    const row: SessionRow = {
      id,
      workspaceId: opts.workspaceId,
      name: opts.name,
      agentKind: adapter.kind,
      adapter: adapter.kind,
      status: 'idle',
      worktreePath,
      branch,
      createdAt: now,
      lastActiveAt: now,
      tokenBudget: null,
      tokenSpent: 0,
      enforcementTier: adapter.enforcementTier,
      pid: null,
    };

    try {
      this.sessions.insert(row);
    } catch (cause) {
      // The row is the only thing that makes the worktree reachable. If the insert
      // fails after the worktree exists, nothing will ever point at it again — a
      // full checkout stranded on disk, plus a branch that makes every retry with
      // the same session name fail with BRANCH_EXISTS. Unwind, best effort, then
      // surface the original failure rather than a cleanup error.
      if (branch !== null) {
        await removeWorktree(root, worktreePath).catch(() => undefined);
        await deleteBranch(root, branch).catch(() => undefined);
      }
      throw cause;
    }
    return row;
  }

  list(workspaceId: string): SessionRow[] {
    return this.sessions.listByWorkspace(workspaceId);
  }

  resolve(workspaceId: string, idOrName: string): SessionRow {
    const found =
      this.sessions.findByName(workspaceId, idOrName) ?? this.sessions.findById(idOrName);
    if (!found || found.workspaceId !== workspaceId) {
      throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${idOrName}`);
    }
    return found;
  }

  rename(workspaceId: string, idOrName: string, newName: string): SessionRow {
    assertValidSessionName(newName);
    const row = this.resolve(workspaceId, idOrName);
    // A session is allowed to keep its own name; only a DIFFERENT session holding it
    // is a collision.
    const clash = this.sessions.findByName(workspaceId, newName);
    if (clash && clash.id !== row.id) {
      throw new CrossweaveError('SESSION_NAME_TAKEN', `Session already exists: ${newName}`);
    }
    this.sessions.rename(row.id, newName);
    return this.resolve(workspaceId, row.id);
  }

  async kill(
    workspaceId: string,
    idOrName: string,
    opts: { removeWorktree: boolean },
  ): Promise<void> {
    const row = this.resolve(workspaceId, idOrName);
    const root = this.projectRoot(workspaceId);

    if (row.pid !== null) {
      try {
        process.kill(row.pid, 'SIGTERM');
      } catch {
        // Already gone; reconciliation handles the bookkeeping.
      }
    }

    // A shared session points at the project root, which must never be removed.
    const ownWorktree =
      row.worktreePath !== null && row.worktreePath !== root ? row.worktreePath : null;
    if (opts.removeWorktree && ownWorktree !== null) {
      await removeWorktree(root, ownWorktree);
      this.sessions.clearWorktree(row.id);
    }

    this.sessions.updateStatus(row.id, 'dead', null);
  }
}
```

- [ ] **Step 4: Verify `clearWorktree` already exists — do NOT add it**

`SessionRepo.clearWorktree` and its test landed with Task 4, not here. Confirm both are
present and leave them alone; appending a second copy is a defect, not a no-op.

```bash
grep -n 'clearWorktree' src/db/repositories/session.ts tests/db/session-repo.test.ts
```

Expected: one method definition in the repository and one test named
`'clears the worktree path'`. If either is missing, stop and report it rather than
adding it here — that would mean Task 4 regressed and the cause matters more than the
symptom.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/domain/session.test.ts tests/db/session-repo.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/domain/session.ts src/db/repositories/session.ts tests/domain/session.test.ts tests/db/session-repo.test.ts
git commit -m "feat(domain): add session manager with worktree lifecycle"
```

---

### Task 9: JSON-RPC framing

**Files:**
- Create: `src/daemon/rpc.ts`
- Test: `tests/daemon/rpc.test.ts`

**Interfaces:**
- Consumes: nothing from this codebase. It does import `StringDecoder` from `node:string_decoder`, which Bun implements — that is a platform builtin, not a dependency, and it is load-bearing (see the decoder's comment).
- Produces:
  - `interface RpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }`
  - `interface RpcError { code: number; message: string; data?: unknown }`
  - `interface RpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: RpcError }`
  - `encodeFrame(msg: RpcRequest | RpcResponse): string`
  - `createFrameDecoder(onMessage: (msg: unknown) => void): (chunk: Buffer | string) => void`
  - `RPC_ERROR_CODES: { PARSE: -32700; INVALID_REQUEST: -32600; METHOD_NOT_FOUND: -32601; INTERNAL: -32603; APPLICATION: -32000 }`

- [ ] **Step 1: Write the failing test**

Create `tests/daemon/rpc.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { encodeFrame, createFrameDecoder, RPC_ERROR_CODES } from '../../src/daemon/rpc.js';

describe('encodeFrame', () => {
  it('emits one newline-terminated JSON line', () => {
    const s = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(s.endsWith('\n')).toBe(true);
    expect(s.split('\n')).toHaveLength(2);
    expect(JSON.parse(s.trim())).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });
});

describe('createFrameDecoder', () => {
  it('decodes a single frame', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));
    decode(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    expect(seen).toHaveLength(1);
  });

  it('decodes frames split across chunk boundaries', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));
    const frame = encodeFrame({ jsonrpc: '2.0', id: 7, method: 'x' });
    decode(frame.slice(0, 5));
    expect(seen).toHaveLength(0);
    decode(frame.slice(5));
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: number }).id).toBe(7);
  });

  it('decodes several frames arriving in one chunk', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));
    decode(
      encodeFrame({ jsonrpc: '2.0', id: 1, method: 'a' }) +
        encodeFrame({ jsonrpc: '2.0', id: 2, method: 'b' }),
    );
    expect(seen.map((m) => (m as { id: number }).id)).toEqual([1, 2]);
  });

  it('skips a malformed line without throwing and keeps decoding', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));
    decode('{not json}\n' + encodeFrame({ jsonrpc: '2.0', id: 3, method: 'c' }));
    expect(seen.map((m) => (m as { id: number }).id)).toEqual([3]);
  });

  it('ignores blank lines', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));
    decode('\n\n' + encodeFrame({ jsonrpc: '2.0', id: 4, method: 'd' }));
    expect(seen).toHaveLength(1);
  });
});

describe('RPC_ERROR_CODES', () => {
  it('uses the standard JSON-RPC codes', () => {
    expect(RPC_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
    expect(RPC_ERROR_CODES.APPLICATION).toBe(-32000);
  });
});

describe('createFrameDecoder byte-level robustness', () => {
  // Regression: decoding each chunk independently turns either half of a UTF-8
  // character that straddles a chunk boundary into U+FFFD. The result is still
  // valid JSON, so nothing throws and the payload is silently wrong.
  it('never corrupts a multi-byte character split across chunks', () => {
    const text = 'hello 😀 world 你好 こんにちは';
    const frame = Buffer.from(
      encodeFrame({ jsonrpc: '2.0', id: 1, method: 'x', params: { text } }),
      'utf8',
    );

    // Every possible split point, not just one — the bug only shows at some offsets.
    for (let i = 1; i < frame.length; i += 1) {
      const seen: unknown[] = [];
      const decode = createFrameDecoder((m) => seen.push(m));
      decode(frame.subarray(0, i));
      decode(frame.subarray(i));
      expect(seen).toHaveLength(1);
      expect((seen[0] as { params: { text: string } }).params.text).toBe(text);
    }
  });

  it('discards an over-long line and resynchronises at the next newline', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));

    decode('x'.repeat(17 * 1024 * 1024));
    expect(seen).toHaveLength(0);

    decode('tail-of-the-oversized-line\n');
    expect(seen).toHaveLength(0);

    decode(encodeFrame({ jsonrpc: '2.0', id: 9, method: 'after' }));
    expect(seen.map((m) => (m as { id: number }).id)).toEqual([9]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/daemon/rpc.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/rpc.js`.

- [ ] **Step 3: Implement `src/daemon/rpc.ts`**

```ts
import { StringDecoder } from 'node:string_decoder';

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: RpcError;
}

export const RPC_ERROR_CODES = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL: -32603,
  APPLICATION: -32000,
} as const;

export function encodeFrame(msg: RpcRequest | RpcResponse): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * A line longer than this is corrupt or hostile. The daemon accepts connections, so
 * a buffer that grows without limit is a memory-exhaustion vector. Set far above any
 * legitimate frame — session scrollback and diffs are the largest payloads.
 */
const MAX_LINE_LENGTH = 16 * 1024 * 1024;

export function createFrameDecoder(
  onMessage: (msg: unknown) => void,
): (chunk: Buffer | string) => void {
  /**
   * `StringDecoder` carries partial multi-byte state between calls. Calling
   * `chunk.toString('utf8')` per chunk instead decodes each half of a UTF-8
   * character split across a chunk boundary independently, baking U+FFFD into the
   * payload: still valid JSON, silently wrong content, and no error to catch. Real
   * sockets split anywhere, so this is reachable in normal operation.
   */
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let discarding = false;

  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (discarding) {
        discarding = false; // This newline ends the over-long line we dropped.
      } else if (line.length > 0) {
        try {
          onMessage(JSON.parse(line));
        } catch {
          // A malformed line is dropped; the stream stays usable.
        }
      }
      index = buffer.indexOf('\n');
    }

    if (buffer.length > MAX_LINE_LENGTH) {
      buffer = '';
      discarding = true;
    }
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/daemon/rpc.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/rpc.ts tests/daemon/rpc.test.ts
git commit -m "feat(daemon): add newline-delimited json-rpc framing"
```

---

### Task 10: Daemon server and method table

**Files:**
- Create: `src/daemon/server.ts`
- Create: `src/daemon/methods.ts`
- Create: `src/daemon/main.ts`
- Test: `tests/daemon/server.test.ts`

**Interfaces:**
- Consumes: `encodeFrame`, `createFrameDecoder`, `RPC_ERROR_CODES` (Task 9); `WorkspaceManager` (Task 6); `SessionManager` (Task 8); `openDatabase` (Task 2)
- Produces:
  - `type MethodHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown`
  - `interface Daemon { listen(): Promise<void>; close(): Promise<void> }`
  - `createDaemon(opts: { socketPath: string; methods: Record<string, MethodHandler> }): Daemon`
  - `buildMethods(db: Database, projectRoot: string): Record<string, MethodHandler>` exposing `ping`, `workspace.init`, `workspace.list`, `workspace.info`, `workspace.delete`, `session.new`, `session.list`, `session.rename`, `session.kill`

- [ ] **Step 1: Write the failing test**

Create `tests/daemon/server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { encodeFrame, createFrameDecoder, RPC_ERROR_CODES } from '../../src/daemon/rpc.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let daemon: Daemon;
let socketPath: string;

function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath, () => {
      sock.write(encodeFrame({ jsonrpc: '2.0', id: 1, method, params }));
    });
    const decode = createFrameDecoder((msg) => {
      const r = msg as { result?: unknown; error?: { code: number; message: string } };
      sock.end();
      if (r.error) reject(r.error);
      else resolve(r.result);
    });
    sock.on('data', decode);
    sock.on('error', reject);
  });
}

beforeEach(async () => {
  fx = await makeGitFixture();
  socketPath = join(fx.root, '.crossweave', 'daemon.sock');
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
  await daemon.listen();
});

afterEach(async () => {
  await daemon.close();
  db.close();
  await fx.cleanup();
});

describe('daemon server', () => {
  it('answers ping', async () => {
    expect(await rpc('ping')).toEqual({ ok: true });
  });

  it('returns METHOD_NOT_FOUND for an unknown method', async () => {
    await expect(rpc('nope')).rejects.toMatchObject({ code: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  });

  it('maps a CrossweaveError to an application error carrying its code', async () => {
    await expect(rpc('workspace.info', { id: 'ghost' })).rejects.toMatchObject({
      code: RPC_ERROR_CODES.APPLICATION,
      data: { code: 'WORKSPACE_NOT_FOUND' },
    });
  });

  it('runs the workspace and session lifecycle end to end', async () => {
    const ws = (await rpc('workspace.init', {})) as { id: string; name: string };
    expect(ws.name).toBe(fx.root.split('/').pop());

    const s = (await rpc('session.new', {
      workspaceId: ws.id, name: 'auth', agent: 'claude', worktree: true,
    })) as { id: string; worktreePath: string; status: string };
    expect(s.status).toBe('idle');
    expect(existsSync(s.worktreePath)).toBe(true);

    const list = (await rpc('session.list', { workspaceId: ws.id })) as unknown[];
    expect(list).toHaveLength(1);

    const renamed = (await rpc('session.rename', {
      workspaceId: ws.id, idOrName: 'auth', newName: 'auth2',
    })) as { name: string };
    expect(renamed.name).toBe('auth2');

    await rpc('session.kill', { workspaceId: ws.id, idOrName: 'auth2', removeWorktree: true });
    expect(existsSync(s.worktreePath)).toBe(false);
  });

  it('creates the socket owner-only and the state directory 0700', async () => {
    const { statSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it('removes a stale socket file on listen', async () => {
    await daemon.close();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(socketPath, 'stale');
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    expect(await rpc('ping')).toEqual({ ok: true });
  });

  // Regression: unlinking unconditionally let a second daemon silently steal the
  // socket from a live one. The first kept running, holding agent ptys, while every
  // client reached the second — and neither process was told.
  it('refuses to steal the socket from a daemon that is still live', async () => {
    const second = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await expect(second.listen()).rejects.toMatchObject({ code: 'DAEMON_ALREADY_RUNNING' });
    // The original is untouched and still serving.
    expect(await rpc('ping')).toEqual({ ok: true });
    await second.close();
  });

  it('creates the state directory owner-only from openDatabase alone', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { statSync } = await import('node:fs');
    const dir = await mkdtemp(join(tmpdir(), 'cw-mode-'));
    try {
      const fresh = openDatabase(join(dir, '.crossweave', 'state.db'));
      expect(statSync(join(dir, '.crossweave')).mode & 0o777).toBe(0o700);
      fresh.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('unlinks the socket on close', async () => {
    await daemon.close();
    expect(existsSync(socketPath)).toBe(false);
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/daemon/server.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/server.js`.

- [ ] **Step 3: Implement `src/daemon/server.ts`**

```ts
import { connect, createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { CrossweaveError } from '../core/errors.js';
import {
  createFrameDecoder,
  encodeFrame,
  RPC_ERROR_CODES,
  type RpcResponse,
} from './rpc.js';

export type MethodHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export interface Daemon {
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * True when a daemon is still bound to this socket path. A leftover socket FILE and
 * a live listener are indistinguishable on disk, so the only reliable test is to try
 * to connect: a crashed daemon's file refuses with ECONNREFUSED.
 */
function isSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    const settle = (live: boolean): void => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
  });
}

/** One bind attempt, as a promise that rejects with the raw errno error. */
function bindOnce(instance: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      instance.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      instance.removeListener('error', onError);
      resolve();
    };
    instance.once('error', onError);
    instance.once('listening', onListening);
    instance.listen(socketPath);
  });
}

export function createDaemon(opts: {
  socketPath: string;
  methods: Record<string, MethodHandler>;
}): Daemon {
  const sockets = new Set<Socket>();
  let server: Server | undefined;

  function respond(sock: Socket, res: RpcResponse): void {
    if (!sock.destroyed) sock.write(encodeFrame(res));
  }

  async function handle(sock: Socket, msg: unknown): Promise<void> {
    const req = msg as { id?: number; method?: string; params?: Record<string, unknown> };
    const id = typeof req.id === 'number' ? req.id : 0;

    if (typeof req.method !== 'string') {
      respond(sock, {
        jsonrpc: '2.0', id,
        error: { code: RPC_ERROR_CODES.INVALID_REQUEST, message: 'Missing method' },
      });
      return;
    }

    const handler = opts.methods[req.method];
    if (!handler) {
      respond(sock, {
        jsonrpc: '2.0', id,
        error: { code: RPC_ERROR_CODES.METHOD_NOT_FOUND, message: `Unknown method: ${req.method}` },
      });
      return;
    }

    try {
      const result = await handler(req.params ?? {});
      respond(sock, { jsonrpc: '2.0', id, result });
    } catch (err) {
      if (err instanceof CrossweaveError) {
        respond(sock, {
          jsonrpc: '2.0', id,
          error: {
            code: RPC_ERROR_CODES.APPLICATION,
            message: err.message,
            data: { code: err.code },
          },
        });
      } else {
        respond(sock, {
          jsonrpc: '2.0', id,
          error: { code: RPC_ERROR_CODES.INTERNAL, message: (err as Error).message },
        });
      }
    }
  }

  return {
    async listen(): Promise<void> {
      // 0o700: the daemon spawns processes and writes files on the user's behalf,
      // so nothing outside this account may reach its directory or its socket.
      // The chmod is not redundant — `mode` on mkdirSync applies only at creation,
      // and openDatabase has usually made this directory already.
      mkdirSync(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
      chmodSync(dirname(opts.socketPath), 0o700);

      const instance = createServer((sock) => {
        sockets.add(sock);
        sock.on('data', createFrameDecoder((msg) => void handle(sock, msg)));
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => sockets.delete(sock));
      });
      server = instance;

      // Bind FIRST and recover, rather than checking the path and then acting on it.
      // `bind()` is atomic in the kernel, so it — not us — decides who owns the
      // socket. Checking `isSocketLive` before unlinking left a window where two
      // starting daemons could each conclude "it's dead" and both unlink and bind,
      // which is the same silent-steal outcome in a narrower form. `listen` reports
      // EADDRINUSE identically for a live socket, a stale socket, and a plain file,
      // so there is no cheaper signal being given up here.
      try {
        await bindOnce(instance, opts.socketPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;

        // Something holds the path. Only crash debris may be cleared: if a daemon
        // answers, it owns the socket and taking it would orphan its live sessions.
        if (await isSocketLive(opts.socketPath)) {
          throw new CrossweaveError(
            'DAEMON_ALREADY_RUNNING',
            `Another crossweave daemon is already listening at ${opts.socketPath}`,
          );
        }

        unlinkSync(opts.socketPath);
        try {
          await bindOnce(instance, opts.socketPath);
        } catch (retry) {
          if ((retry as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            // Another starter won between our unlink and our retry. Losing this way
            // is safe and retryable — it never steals a socket.
            throw new CrossweaveError(
              'DAEMON_ALREADY_RUNNING',
              `Another crossweave daemon took ${opts.socketPath} first`,
            );
          }
          throw retry;
        }
      }

      // Unix socket permissions follow umask by default, which on many systems
      // leaves the socket group- and world-readable. Anyone able to connect can
      // drive the daemon, so tighten it explicitly rather than trusting umask.
      chmodSync(opts.socketPath, 0o600);
    },

    close(): Promise<void> {
      for (const s of sockets) s.destroy();
      sockets.clear();
      return new Promise((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => {
          if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
          server = undefined;
          resolve();
        });
      });
    },
  };
}
```

- [ ] **Step 4: Implement `src/daemon/methods.ts`**

```ts
import type { Database } from 'bun:sqlite';
import { WorkspaceManager } from '../domain/workspace.js';
import { SessionManager } from '../domain/session.js';
import type { MethodHandler } from './server.js';

// A malformed request is the caller's fault, not an internal failure. Throwing a bare
// TypeError made the server map it to INTERNAL and hand the client a raw internal
// message it could not branch on.
function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string') {
    throw new CrossweaveError('INVALID_PARAMS', `Expected string param: ${key}`);
  }
  return v;
}

function optionalStr(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' ? v : undefined;
}

function bool(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = params[key];
  return typeof v === 'boolean' ? v : fallback;
}

export function buildMethods(
  db: Database,
  projectRoot: string,
): Record<string, MethodHandler> {
  const workspaces = new WorkspaceManager(db);
  const sessions = new SessionManager(db);

  return {
    ping: () => ({ ok: true }),

    'workspace.init': (p) => workspaces.init(projectRoot, optionalStr(p, 'name')),
    'workspace.list': () => workspaces.list(),
    'workspace.info': (p) => workspaces.info(str(p, 'id')),
    'workspace.delete': (p) => {
      workspaces.delete(str(p, 'id'), { force: bool(p, 'force', false) });
      return { ok: true };
    },

    'session.new': (p) =>
      sessions.create({
        workspaceId: str(p, 'workspaceId'),
        name: str(p, 'name'),
        agent: str(p, 'agent'),
        worktree: bool(p, 'worktree', true),
      }),
    'session.list': (p) => sessions.list(str(p, 'workspaceId')),
    'session.rename': (p) =>
      sessions.rename(str(p, 'workspaceId'), str(p, 'idOrName'), str(p, 'newName')),
    'session.kill': async (p) => {
      await sessions.kill(str(p, 'workspaceId'), str(p, 'idOrName'), {
        removeWorktree: bool(p, 'removeWorktree', false),
      });
      return { ok: true };
    },
  };
}
```

- [ ] **Step 5: Implement `src/daemon/main.ts`**

The daemon entry point. `cw` spawns this detached when no socket answers.

```ts
import { join } from 'node:path';
import { openDatabase } from '../db/open.js';
import { crossweaveDir, findProjectRoot } from '../core/paths.js';
import { createDaemon } from './server.js';
import { buildMethods } from './methods.js';

async function main(): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const dir = crossweaveDir(projectRoot);
  const db = openDatabase(join(dir, 'state.db'));
  const daemon = createDaemon({
    socketPath: join(dir, 'daemon.sock'),
    methods: buildMethods(db, projectRoot),
  });

  await daemon.listen();
  process.stdout.write(`crossweave daemon listening at ${join(dir, 'daemon.sock')}\n`);

  const shutdown = (): void => {
    void daemon.close().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test tests/daemon/server.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add src/daemon tests/daemon
git commit -m "feat(daemon): add unix-socket rpc server, method table and entry point"
```

---

### Task 11: Daemon client with auto-start

**Files:**
- Create: `src/client/rpc-client.ts`
- Test: `tests/client/rpc-client.test.ts`

**Interfaces:**
- Consumes: `encodeFrame`, `createFrameDecoder` (Task 9); `crossweaveDir` (Task 1); `createDaemon` (Task 10)
- Produces:
  - `class DaemonClient` with `static connect(socketPath: string): Promise<DaemonClient>`, `call<T>(method: string, params?: Record<string, unknown>): Promise<T>`, `close(): void`
  - `connectOrStart(projectRoot: string): Promise<DaemonClient>`

- [ ] **Step 1: Write the failing test**

Create `tests/client/rpc-client.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DaemonClient, connectOrStart } from '../../src/client/rpc-client.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let daemon: Daemon | undefined;
let socketPath: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  socketPath = join(fx.root, '.crossweave', 'daemon.sock');
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
});

afterEach(async () => {
  if (daemon) await daemon.close();
  daemon = undefined;
  db.close();
  await fx.cleanup();
});

describe('DaemonClient', () => {
  it('calls a method and gets the result', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    expect(await client.call<{ ok: boolean }>('ping')).toEqual({ ok: true });
    client.close();
  });

  it('multiplexes concurrent calls onto one connection', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    const results = await Promise.all([
      client.call<{ ok: boolean }>('ping'), client.call<{ ok: boolean }>('ping'), client.call<{ ok: boolean }>('ping'),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    client.close();
  });

  it('rejects with the application error code from the daemon', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    await expect(client.call('workspace.info', { id: 'ghost' })).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    });
    client.close();
  });

  it('fails to connect when nothing is listening', async () => {
    await expect(DaemonClient.connect(socketPath)).rejects.toBeTruthy();
  });

  // Regression: `connect` strips its temporary 'error' listener once connected, and
  // the constructor only registered 'data' and 'close'. Node THROWS an 'error' event
  // with no listener, so a daemon dying mid-session killed the CLI with an uncaught
  // exception instead of rejecting the call.
  it('rejects with DAEMON_GONE instead of crashing or hanging when the daemon goes away', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    expect(await client.call<{ ok: boolean }>('ping')).toEqual({ ok: true });

    await daemon.close();
    daemon = undefined;

    // Wait for the client to actually observe the disconnect rather than racing the
    // teardown. This loop can only exit once the state under test is real, and the
    // per-test timeout is what catches it if the client never notices — which is
    // precisely the regression: the earlier version hung here forever.
    while (client.isConnected) await new Promise((r) => setTimeout(r, 5));

    await expect(client.call('ping')).rejects.toMatchObject({ code: 'DAEMON_GONE' });
    client.close();
  });
});

describe('connectOrStart', () => {
  it('starts a daemon when none is running, then answers', async () => {
    const client = await connectOrStart(fx.root);
    expect(await client.call<{ ok: boolean }>('ping')).toEqual({ ok: true });
    await client.call('daemon.shutdown').catch(() => undefined);
    client.close();
  }, 30_000);
});
```

- [ ] **Step 2: Add the `daemon.shutdown` method**

`connectOrStart` spawns a detached daemon, so tests need a way to stop it.
Add to the returned object in `src/daemon/methods.ts` (inside `buildMethods`):

```ts
    'daemon.shutdown': () => {
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/client/rpc-client.test.ts`
Expected: FAIL — cannot resolve `../../src/client/rpc-client.js`.

- [ ] **Step 4: Implement `src/client/rpc-client.ts`**

```ts
import { connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrossweaveError } from '../core/errors.js';
import { crossweaveDir } from '../core/paths.js';
import { createFrameDecoder, encodeFrame } from '../daemon/rpc.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class DaemonClient {
  private nextId = 1;
  private gone = false;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly socket: Socket) {
    socket.on(
      'data',
      createFrameDecoder((msg) => {
        const r = msg as {
          id?: number;
          result?: unknown;
          error?: { message: string; data?: { code?: string } };
        };
        if (typeof r.id !== 'number') return;
        const p = this.pending.get(r.id);
        if (!p) return;
        this.pending.delete(r.id);
        if (r.error) {
          p.reject(new CrossweaveError(r.error.data?.code ?? 'RPC_ERROR', r.error.message));
        } else {
          p.resolve(r.result);
        }
      }),
    );
    // Node THROWS an 'error' event that has no listener, so without this the CLI
    // dies with an uncaught exception when the daemon goes away mid-call instead of
    // the caller getting a clean rejection. `connect` strips its own temporary error
    // listener once connected, which is exactly why one has to be re-registered here.
    socket.on('error', (err: Error) => {
      this.failAll(`Daemon connection failed: ${err.message}`);
    });
    socket.on('close', () => {
      this.failAll('Daemon connection closed');
    });
    // 'end' is the one that actually matters. When the daemon half-closes, no
    // response can ever arrive — but if a write is already stalled in the socket,
    // 'close' never fires and neither does 'error', so without this a pending call
    // hangs forever rather than failing. A hung CLI is worse than a failed one.
    socket.on('end', () => {
      this.failAll('Daemon closed the connection');
    });
  }

  /** True until the connection is known to be gone. */
  get isConnected(): boolean {
    return !this.gone && !this.socket.destroyed && this.socket.writable;
  }

  /**
   * Fires once when the connection is known gone. Registering after the fact fires
   * immediately, so a caller cannot miss it by racing the disconnect. `cw session
   * attach` needs this: without it the CLI hung forever with the terminal in raw
   * mode when the daemon died.
   */
  onClose(cb: () => void): void {
    if (this.gone) {
      cb();
      return;
    }
    this.closeHandlers.push(cb);
  }

  /** Reject everything in flight. Idempotent — 'end', 'error' and 'close' overlap. */
  private failAll(message: string): void {
    this.gone = true;
    for (const p of this.pending.values()) {
      p.reject(new CrossweaveError('DAEMON_GONE', message));
    }
    this.pending.clear();

    for (const cb of this.closeHandlers.splice(0)) {
      try {
        cb();
      } catch {
        // One handler's failure must not stop the others from restoring their state.
      }
    }
  }

  static connect(socketPath: string): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const sock = connect(socketPath);
      sock.once('connect', () => {
        sock.removeAllListeners('error');
        resolve(new DaemonClient(sock));
      });
      sock.once('error', reject);
    });
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // Writing into a socket whose peer is gone succeeds locally and then waits for a
    // response that can never come. Fail fast instead of registering a promise that
    // nothing will ever settle.
    if (!this.isConnected) {
      return Promise.reject(
        new CrossweaveError('DAEMON_GONE', `Daemon connection is gone; cannot call ${method}`),
      );
    }

    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    this.socket.end();
  }
}

const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_POLL_INTERVAL_MS = 100;

/**
 * `daemonEntry` defaults to the sibling source entry point; Bun runs TypeScript
 * directly, so there is no build step to resolve around. The parameter stays
 * overridable because the compiled single binary (packaging task) spawns the
 * sibling `cwd` executable instead.
 */
export async function connectOrStart(
  projectRoot: string,
  daemonEntry = fileURLToPath(new URL('../daemon/main.ts', import.meta.url)),
): Promise<DaemonClient> {
  const socketPath = join(crossweaveDir(projectRoot), 'daemon.sock');

  try {
    return await DaemonClient.connect(socketPath);
  } catch {
    // Nothing listening; start one below.
  }

  const child = spawn(process.execPath, [daemonEntry], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await DaemonClient.connect(socketPath);
    } catch {
      await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS));
    }
  }

  throw new CrossweaveError(
    'DAEMON_START_FAILED',
    `Daemon did not come up within ${DAEMON_START_TIMEOUT_MS}ms at ${socketPath}`,
  );
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/client/rpc-client.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/client src/daemon/methods.ts tests/client
git commit -m "feat(client): add daemon rpc client with auto-start"
```

---

### Task 12: CLI

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/context.ts`
- Create: `src/cli/commands/workspace.ts`
- Create: `src/cli/commands/session.ts`
- Test: `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `connectOrStart` (Task 11), `findProjectRoot` (Task 1)
- Produces:
  - `withClient<T>(fn: (client: DaemonClient, projectRoot: string) => Promise<T>): Promise<T>`
  - `cw init`, `cw workspace list|info|delete`, `cw session new|list|rename|kill`, `cw daemon stop`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/cli.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
let fx: GitFixture;

interface CwResult { exitCode: number; stdout: string; stderr: string }

async function run(cwd: string, args: string[]): Promise<CwResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

function cw(args: string[]): Promise<CwResult> {
  return run(fx.root, args);
}

beforeEach(async () => { fx = await makeGitFixture(); });
afterEach(async () => {
  await cw(['daemon', 'stop']);
  await fx.cleanup();
});

describe('cw CLI', () => {
  it('init creates the workspace and prints its name', async () => {
    const r = await cw(['init']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(fx.root.split('/').pop()!);
    expect(existsSync(join(fx.root, '.crossweave', 'state.db'))).toBe(true);
  }, 30_000);

  it('runs the full session lifecycle', async () => {
    await cw(['init']);

    const created = await cw(['session', 'new', '--name', 'auth', '--agent', 'claude']);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain('auth');
    expect(existsSync(join(fx.root, '.crossweave', 'worktrees'))).toBe(true);

    const listed = await cw(['session', 'list']);
    expect(listed.stdout).toContain('auth');
    expect(listed.stdout).toContain('idle');
    expect(listed.stdout).toContain('T3');

    const renamed = await cw(['session', 'rename', 'auth', 'auth2']);
    expect(renamed.exitCode).toBe(0);
    expect((await cw(['session', 'list'])).stdout).toContain('auth2');

    const killed = await cw(['session', 'kill', 'auth2', '--rm-worktree', '--yes']);
    expect(killed.exitCode).toBe(0);
    expect((await cw(['session', 'list'])).stdout).toContain('dead');
  }, 60_000);

  it('exits non-zero with the error code on a bad session name', async () => {
    await cw(['init']);
    const r = await cw(['session', 'kill', 'ghost', '--yes']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('SESSION_NOT_FOUND');
  }, 30_000);

  it('refuses --rm-worktree without --yes, in the same CODE: format as every other error', async () => {
    await cw(['init']);
    await cw(['session', 'new', '--name', 'guarded', '--agent', 'claude']);
    const r = await cw(['session', 'kill', 'guarded', '--rm-worktree']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('CONFIRMATION_REQUIRED:');
    // The session must still be alive — a refused command changes nothing.
    expect((await cw(['session', 'list'])).stdout).toContain('guarded');
  }, 60_000);

  it('rejects an invalid session name on exactly one stderr line', async () => {
    await cw(['init']);
    const r = await cw(['session', 'new', '--name', 'bad name', '--agent', 'claude']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('INVALID_SESSION_NAME:');
    // The contract the TUI parses: every stderr line carries a CODE: prefix.
    const lines = r.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
  }, 30_000);

  it('daemon stop reports success without starting a daemon when none is running', async () => {
    const r = await cw(['daemon', 'stop']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no daemon running');
    // And it must not have spawned one on the way out.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(fx.root, '.crossweave', 'daemon.sock'))).toBe(false);
  }, 30_000);

  it('exits non-zero outside a git repository', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const bare = await mkdtemp(join(tmpdir(), 'cw-nogit-'));
    try {
      const r = await run(bare, ['init']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('NOT_A_REPO');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/cli.test.ts`
Expected: FAIL — `src/cli/index.ts` does not exist.

- [ ] **Step 3: Implement `src/cli/context.ts`**

```ts
import { findProjectRoot } from '../core/paths.js';
import { connectOrStart, type DaemonClient } from '../client/rpc-client.js';
import { CrossweaveError } from '../core/errors.js';

export async function withClient<T>(
  fn: (client: DaemonClient, projectRoot: string) => Promise<T>,
): Promise<T> {
  const projectRoot = findProjectRoot(process.cwd());
  const client = await connectOrStart(projectRoot);
  try {
    return await fn(client, projectRoot);
  } finally {
    client.close();
  }
}

/** Every command funnels failures here so the exit code and stderr shape stay uniform. */
export function fail(err: unknown): never {
  const code = err instanceof CrossweaveError ? err.code : 'INTERNAL';
  // Collapse to exactly one line. Errors that wrap a subprocess's output carry its
  // multi-line stderr, and those extra lines would reach the terminal with no `CODE:`
  // prefix — the one thing a script or the TUI cannot parse.
  const message = String((err as Error).message).replace(/\s*\n\s*/g, ' ');
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

export async function currentWorkspaceId(client: DaemonClient): Promise<string> {
  const ws = await client.call<{ id: string }>('workspace.init', {});
  return ws.id;
}
```

- [ ] **Step 4: Implement `src/cli/commands/workspace.ts`**

```ts
import { defineCommand } from 'citty';
import { withClient, fail } from '../context.js';

interface Workspace { id: string; name: string; rootPath: string }
interface Session { id: string; name: string; status: string; enforcementTier: string }

export const initCommand = defineCommand({
  meta: { name: 'init', description: 'Create or attach the workspace for this repository' },
  args: { name: { type: 'string', description: 'Workspace name (defaults to the directory name)' } },
  async run({ args }) {
    try {
      await withClient(async (client) => {
        const params = args.name ? { name: args.name } : {};
        const ws = await client.call<Workspace>('workspace.init', params);
        process.stdout.write(`workspace ${ws.name} (${ws.id})\n${ws.rootPath}\n`);
      });
    } catch (err) { fail(err); }
  },
});

export const workspaceCommand = defineCommand({
  meta: { name: 'workspace', description: 'Manage workspaces' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List workspaces' },
      async run() {
        try {
          await withClient(async (client) => {
            const rows = await client.call<Workspace[]>('workspace.list');
            if (rows.length === 0) { process.stdout.write('no workspaces\n'); return; }
            for (const w of rows) process.stdout.write(`${w.name}\t${w.id}\t${w.rootPath}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),

    info: defineCommand({
      meta: { name: 'info', description: 'Show the current workspace and its sessions' },
      async run() {
        try {
          await withClient(async (client) => {
            const ws = await client.call<Workspace>('workspace.init', {});
            const info = await client.call<{ workspace: Workspace; sessions: Session[] }>(
              'workspace.info', { id: ws.id },
            );
            process.stdout.write(`${info.workspace.name}\t${info.workspace.rootPath}\n`);
            process.stdout.write(`sessions: ${info.sessions.length}\n`);
            for (const s of info.sessions) {
              process.stdout.write(`  ${s.name}\t${s.status}\t${s.enforcementTier}\n`);
            }
          });
        } catch (err) { fail(err); }
      },
    }),

    delete: defineCommand({
      meta: { name: 'delete', description: 'Delete a workspace' },
      args: {
        name: { type: 'positional', description: 'Workspace name or id' },
        force: { type: 'boolean', description: 'Delete even with live sessions', default: false },
      },
      async run({ args }) {
        try {
          await withClient(async (client) => {
            await client.call('workspace.delete', { id: args.name, force: args.force });
            process.stdout.write(`deleted ${args.name}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
  },
});
```

- [ ] **Step 5: Implement `src/cli/commands/session.ts`**

```ts
import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';

interface Session {
  id: string; name: string; status: string; agentKind: string;
  enforcementTier: string; worktreePath: string | null; branch: string | null;
}

export const sessionCommand = defineCommand({
  meta: { name: 'session', description: 'Manage sessions' },
  subCommands: {
    new: defineCommand({
      meta: { name: 'new', description: 'Create a session' },
      // citty derives `--no-worktree` automatically from a boolean named `worktree`,
      // so declaring a literal `no-worktree` flag would collide with that negation.
      args: {
        name: { type: 'string', required: true, description: 'Session name' },
        agent: { type: 'string', default: 'claude', description: 'Agent kind' },
        worktree: { type: 'boolean', default: true, description: 'Isolate in a git worktree' },
      },
      async run({ args }) {
        try {
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const worktree = args.worktree;
            if (!worktree) {
              process.stderr.write(
                'warning: --no-worktree shares the project root. ' +
                  'Sessions can overwrite each other\'s files.\n',
              );
            }
            const s = await client.call<Session>('session.new', {
              workspaceId, name: args.name, agent: args.agent, worktree,
            });
            process.stdout.write(
              `${s.name}\t${s.status}\t${s.enforcementTier}\t${s.worktreePath ?? '-'}\n`,
            );
          });
        } catch (err) { fail(err); }
      },
    }),

    list: defineCommand({
      meta: { name: 'list', description: 'List sessions' },
      async run() {
        try {
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const rows = await client.call<Session[]>('session.list', { workspaceId });
            if (rows.length === 0) { process.stdout.write('no sessions\n'); return; }
            process.stdout.write('NAME\tSTATUS\tAGENT\tTIER\tBRANCH\n');
            for (const s of rows) {
              process.stdout.write(
                `${s.name}\t${s.status}\t${s.agentKind}\t${s.enforcementTier}\t${s.branch ?? '-'}\n`,
              );
            }
          });
        } catch (err) { fail(err); }
      },
    }),

    rename: defineCommand({
      meta: { name: 'rename', description: 'Rename a session' },
      args: {
        target: { type: 'positional', description: 'Session name or id' },
        newName: { type: 'positional', description: 'New name' },
      },
      async run({ args }) {
        try {
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const s = await client.call<Session>('session.rename', {
              workspaceId, idOrName: args.target, newName: args.newName,
            });
            process.stdout.write(`${s.name}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),

    kill: defineCommand({
      meta: { name: 'kill', description: 'Kill a session' },
      args: {
        target: { type: 'positional', description: 'Session name or id' },
        'rm-worktree': { type: 'boolean', default: false, description: 'Also remove the worktree' },
        yes: { type: 'boolean', default: false, description: 'Skip confirmation' },
      },
      async run({ args }) {
        try {
          // Goes through fail() like every other error path. A guard that printed its
          // own format would be the one place a script could not parse, and this is
          // the destructive one.
          if (args['rm-worktree'] && !args.yes) {
            throw new CrossweaveError(
              'CONFIRMATION_REQUIRED',
              'Refusing to remove a worktree without confirmation. Re-run with --yes.',
            );
          }
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            await client.call('session.kill', {
              workspaceId, idOrName: args.target, removeWorktree: args['rm-worktree'],
            });
            process.stdout.write(`killed ${args.target}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
  },
});
```

- [ ] **Step 6: Implement `src/cli/index.ts`**

```ts
#!/usr/bin/env bun
import { join } from 'node:path';
import { defineCommand, runMain } from 'citty';
import { crossweaveDir, findProjectRoot } from '../core/paths.js';
import { DaemonClient } from '../client/rpc-client.js';
import { initCommand, workspaceCommand } from './commands/workspace.js';
import { sessionCommand } from './commands/session.js';
import { fail } from './context.js';

const daemonCommand = defineCommand({
  meta: { name: 'daemon', description: 'Manage the crossweave daemon' },
  subCommands: {
    stop: defineCommand({
      meta: { name: 'stop', description: 'Stop the daemon for this repository' },
      async run() {
        try {
          // Deliberately connects rather than using withClient: connectOrStart would
          // spawn a daemon just to shut it down. Nothing listening means the daemon is
          // already stopped, which is the outcome asked for, so it exits 0.
          const projectRoot = findProjectRoot(process.cwd());
          const socketPath = join(crossweaveDir(projectRoot), 'daemon.sock');

          let client: DaemonClient;
          try {
            client = await DaemonClient.connect(socketPath);
          } catch {
            process.stdout.write('no daemon running\n');
            return;
          }

          await client.call('daemon.shutdown').catch(() => undefined);
          client.close();
          process.stdout.write('daemon stopped\n');
        } catch (err) { fail(err); }
      },
    }),
  },
});

const main = defineCommand({
  meta: { name: 'cw', description: 'crossweave — parallel agents that stay mergeable' },
  subCommands: {
    init: initCommand,
    workspace: workspaceCommand,
    session: sessionCommand,
    daemon: daemonCommand,
  },
});

void runMain(main);
```

- [ ] **Step 7: Build, then run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all PASS across every test file, 0 type errors.

- [ ] **Step 8: Commit**

```bash
git add src/cli tests/cli
git commit -m "feat(cli): add cw init, workspace, session and daemon commands"
```

---

### Task 13: Session runtime — start, attach, resume, stop

Tasks 1–12 create worktrees and rows but never run an agent. This task is what
makes M0 fulfil its promise: the daemon owns a live pty per session, and the CLI
bridges the local terminal to it.

Two properties of the Task 7 adapter this task is built on, both verified by tests
there rather than assumed:

- **The adapter buffers nothing.** Anything emitted before a subscriber attaches is
  gone. `SessionRuntime`'s `scrollback` is therefore load-bearing, not a nicety — it
  is the only reason a client that attaches to an already-running session sees
  anything at all. That is also why `start()` registers its `onData` handler
  immediately, before any client can subscribe.
- **Fan-out is isolated.** A listener that throws no longer aborts delivery to the
  others, so one broken attached client cannot starve the rest.

**Files:**
- Create: `src/daemon/runtime.ts`
- Create: `src/cli/commands/attach.ts`
- Modify: `src/daemon/server.ts` — `MethodHandler` gains a context parameter
- Modify: `src/daemon/methods.ts` — new session runtime methods, injectable adapter factory
- Modify: `src/domain/session.ts` — injectable adapter factory
- Modify: `src/client/rpc-client.ts` — notification handling
- Modify: `src/cli/commands/session.ts` — register the attach subcommand. `src/cli/index.ts` needs no change; `session` is already wired into the root command there.
- Test: `tests/daemon/runtime.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentProcess` (Task 7); `SessionRepo` (Task 4); `createDaemon` (Task 10); `DaemonClient` (Task 11)
- Produces:
  - `interface MethodContext { notify(method: string, params: unknown): void; onClose(cb: () => void): void }`
  - `type MethodHandler = (params: Record<string, unknown>, ctx: MethodContext) => Promise<unknown> | unknown`
  - `type AdapterFactory = (kind: string) => AgentAdapter`
  - `class SessionRuntime` with `start(session: SessionRow, adapter: AgentAdapter): void`, `isRunning(id: string): boolean`, `write(id: string, data: string): void`, `resize(id: string, cols: number, rows: number): void`, `subscribe(id: string, ctx: MethodContext): void`, `stop(id: string): void`, `stopAll(): void`
  - `DaemonClient.onNotification(cb: (method: string, params: unknown) => void): void`

- [ ] **Step 1: Write the failing test**

Create `tests/daemon/runtime.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DaemonClient } from '../../src/client/rpc-client.js';
import { ClaudePtyAdapter } from '../../src/adapters/claude-pty.js';
import { CrossweaveError } from '../../src/core/errors.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

/** Echoes each stdin line back, so tests never need the real `claude` binary. */
function echoFactory(kind: string): AgentAdapter {
  if (kind !== 'claude') throw new CrossweaveError('UNKNOWN_AGENT', `Unsupported: ${kind}`);
  return new ClaudePtyAdapter('sh', ['-c', 'while IFS= read -r l; do echo "echo:$l"; done']);
}

let fx: GitFixture;
let db: Database;
let daemon: Daemon;
let client: DaemonClient;
let socketPath: string;
let workspaceId: string;

/** Accepts an async predicate — several conditions here are only observable over RPC. */
async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}

beforeEach(async () => {
  fx = await makeGitFixture();
  socketPath = join(fx.root, '.crossweave', 'daemon.sock');
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  daemon = createDaemon({
    socketPath,
    methods: buildMethods(db, fx.root, echoFactory),
  });
  await daemon.listen();
  client = await DaemonClient.connect(socketPath);
  workspaceId = (await client.call<{ id: string }>('workspace.init', {})).id;
});

afterEach(async () => {
  client.close();
  await daemon.close();
  db.close();
  await fx.cleanup();
});

describe('attach detach key', () => {
  // Regression, and the cheapest possible guard on the defect that actually shipped:
  // the literal control byte was lost in transcription, leaving ''. With the old
  // `includes` check that made the FIRST keystroke detach, so no input ever reached
  // the agent — the headline feature of this milestone was completely dead, and no
  // test noticed because the interactive path was explicitly waived.
  it('is Ctrl-] and exactly one character', async () => {
    const { DETACH_KEY } = await import('../../src/cli/commands/attach.js');
    expect(DETACH_KEY).toBe('\x1d');
    expect(DETACH_KEY).toHaveLength(1);
    expect(DETACH_KEY).not.toBe('');
  });
});

describe('SessionRuntime subscriber isolation', () => {
  // Task 7 isolated the ADAPTER's fan-out; SessionRuntime has its own loops and had
  // to be fixed separately. The exit path mattered most: a throw there skipped
  // `running.delete` and `onExit`, wedging the session at `running` with a stale pid
  // and making it permanently unstartable.
  function fakeContext(onNotify: (m: string) => void): MethodContext {
    return { notify: (m) => onNotify(m), onClose: () => undefined };
  }

  it('keeps delivering to other subscribers when one throws, and still cleans up', async () => {
    const exits: string[] = [];
    const runtime = new SessionRuntime((id) => exits.push(id));
    const row = await sessions.create({
      workspaceId, name: 'iso', agent: 'claude', worktree: true,
    });

    const seen: string[] = [];
    runtime.start(row, new ClaudePtyAdapter('sh', ['-c', 'echo hi; exit 0']));
    runtime.subscribe(row.id, row.name, fakeContext(() => seen.push('first')));
    runtime.subscribe(row.id, row.name, fakeContext(() => { throw new Error('bad'); }));
    runtime.subscribe(row.id, row.name, fakeContext(() => seen.push('third')));

    await waitFor(() => exits.includes(row.id));

    expect(seen).toContain('first');
    expect(seen).toContain('third');
    // The bookkeeping must have run despite the throw.
    expect(runtime.isRunning(row.id)).toBe(false);
  }, 15_000);
});

describe('session runtime', () => {
  it('starts an agent and marks the session running with a pid', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    const started = await client.call<{ status: string; pid: number }>('session.start', {
      workspaceId, idOrName: 'auth',
    });
    expect(started.status).toBe('running');
    expect(started.pid).toBeGreaterThan(0);
  });

  it('streams agent output to a subscriber and accepts input', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });

    let seen = '';
    client.onNotification((method, params) => {
      if (method === 'session.data') seen += (params as { chunk: string }).chunk;
    });

    await client.call('session.attach', { workspaceId, idOrName: 'auth' });
    await client.call('session.input', { workspaceId, idOrName: 'auth', data: 'ping\n' });
    await waitFor(() => seen.includes('echo:ping'));
    expect(seen).toContain('echo:ping');
  });

  it('replays recent scrollback to a late subscriber', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });
    await client.call('session.attach', { workspaceId, idOrName: 'auth' });
    await client.call('session.input', { workspaceId, idOrName: 'auth', data: 'early\n' });

    let late = '';
    const second = await DaemonClient.connect(socketPath);
    second.onNotification((method, params) => {
      if (method === 'session.data') late += (params as { chunk: string }).chunk;
    });
    await new Promise((r) => setTimeout(r, 300));
    await second.call('session.attach', { workspaceId, idOrName: 'auth' });
    await waitFor(() => late.includes('echo:early'));
    expect(late).toContain('echo:early');
    second.close();
  });

  it('refuses to start an already running session', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });
    await expect(client.call('session.start', { workspaceId, idOrName: 'auth' })).rejects.toMatchObject(
      { code: 'SESSION_ALREADY_RUNNING' },
    );
  });

  it('refuses to attach to a session that is not running', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await expect(client.call('session.attach', { workspaceId, idOrName: 'auth' })).rejects.toMatchObject(
      { code: 'SESSION_NOT_RUNNING' },
    );
  });

  it('marks the session idle and clears the pid when the agent exits', async () => {
    await client.call('session.new', { workspaceId, name: 'bye', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'bye' });
    await client.call('session.stop', { workspaceId, idOrName: 'bye' });

    // Wait on the condition itself. The runtime's exit handler is asynchronous, so
    // anything that does not observe the actual row is testing nothing.
    type Row = { name: string; status: string; pid: number | null };
    let row: Row | undefined;
    await waitFor(async () => {
      const rows = await client.call<Row[]>('session.list', { workspaceId });
      row = rows.find((r) => r.name === 'bye');
      return row !== undefined && row.pid === null && row.status !== 'running';
    });

    expect(row?.status).toBe('idle');
    expect(row?.pid).toBeNull();
  });

  // Regression: neither start nor resume checked the status, so a killed session
  // could be resumed straight back to running — which would have made `dead` and
  // `idle` the same thing and the kill meaningless.
  it('refuses to start or resume a killed session', async () => {
    await client.call('session.new', { workspaceId, name: 'gone', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'gone' });
    await client.call('session.kill', { workspaceId, idOrName: 'gone', removeWorktree: false });

    await expect(
      client.call('session.resume', { workspaceId, idOrName: 'gone' }),
    ).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    await expect(
      client.call('session.start', { workspaceId, idOrName: 'gone' }),
    ).rejects.toMatchObject({ code: 'SESSION_ENDED' });

    // Checked immediately, while the runtime may still report the pty as running —
    // that window used to return a stale `dead` row with no error.
    const rows = await client.call<{ name: string; status: string }[]>(
      'session.list', { workspaceId },
    );
    expect(rows.find((r) => r.name === 'gone')?.status).toBe('dead');
  });

  // Regression, and the reason this assertion is on the PID: a reviewer replaced
  // session.resume's body with `return row` — never restarting anything — and the
  // entire 133-test suite still passed, because the stale pre-exit row already said
  // "running". Asserting on status alone tested nothing.
  it('resume after stop starts a genuinely new process', async () => {
    await client.call('session.new', { workspaceId, name: 'again', agent: 'claude', worktree: true });
    const first = await client.call<{ pid: number }>('session.start', {
      workspaceId, idOrName: 'again',
    });
    await client.call('session.stop', { workspaceId, idOrName: 'again' });

    const second = await client.call<{ pid: number; status: string }>('session.resume', {
      workspaceId, idOrName: 'again',
    });
    expect(second.status).toBe('running');
    expect(second.pid).not.toBe(first.pid);
  });

  // Regression: stop returned as soon as SIGTERM was sent, so an agent that ignores
  // it was reported stopped while still alive — and kill then cleared the pid,
  // leaving a stranded process nothing could ever find again.
  //
  // Tested directly against SessionRuntime with a short grace period, and it waits
  // for the trap to be INSTALLED before signalling. An earlier version of this test
  // signalled immediately and the agent died from the raw SIGTERM before its trap
  // existed — so it passed in 0.14s without ever reaching the SIGKILL branch it
  // claimed to cover. Asserting on elapsed time is what keeps it honest.
  it('escalates to SIGKILL when the agent ignores SIGTERM', async () => {
    const runtime = new SessionRuntime(() => undefined);
    const row = await sessions.create({
      workspaceId, name: 'stubborn', agent: 'claude', worktree: true,
    });
    const pid = runtime.start(
      row,
      new ClaudePtyAdapter('sh', ['-c', 'trap "" TERM; echo TRAPPED; while true; do sleep 0.05; done']),
    );

    let out = '';
    runtime.subscribe(row.id, row.name, {
      notify: (_m, p) => { out += (p as { chunk?: string }).chunk ?? ''; },
      onClose: () => undefined,
    });
    await waitFor(() => out.includes('TRAPPED'));

    const startedAt = Date.now();
    await runtime.stop(row.id, 200);
    const elapsed = Date.now() - startedAt;

    expect(runtime.isRunning(row.id)).toBe(false);
    // Proof the escalation branch actually ran rather than the process dying on the
    // first signal: it cannot have returned before the grace period elapsed.
    expect(elapsed).toBeGreaterThanOrEqual(200);

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 15_000);

  it('resume starts a stopped session again', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });
    await client.call('session.stop', { workspaceId, idOrName: 'auth' });
    const again = await client.call<{ status: string }>('session.resume', {
      workspaceId, idOrName: 'auth',
    });
    expect(again.status).toBe('running');
  });

  // Regression: kill() writes 'dead' synchronously right after SIGTERM, but the pty's
  // exit callback arrives later and used to overwrite it with 'idle'. A killed session
  // that reads back as idle is worse than useless — `cw session list` would lie.
  it('kill stops a running agent and the exit handler does not resurrect it', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });
    await client.call('session.kill', { workspaceId, idOrName: 'auth', removeWorktree: false });

    type Row = { name: string; status: string };
    const statusOf = async (): Promise<string | undefined> => {
      const rows = await client.call<Row[]>('session.list', { workspaceId });
      return rows.find((r) => r.name === 'auth')?.status;
    };

    expect(await statusOf()).toBe('dead');
    // Give the pty's async exit callback time to land, then confirm it did not win.
    await new Promise((r) => setTimeout(r, 300));
    expect(await statusOf()).toBe('dead');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/daemon/runtime.test.ts`
Expected: FAIL — `buildMethods` takes two arguments, and `session.start` does not exist.

- [ ] **Step 3: Add `MethodContext` to `src/daemon/server.ts`**

Replace the `MethodHandler` type and the `handle` function's invocation, and extend
the connection handler to build a context per socket:

```ts
export interface MethodContext {
  notify(method: string, params: unknown): void;
  onClose(cb: () => void): void;
}

export type MethodHandler = (
  params: Record<string, unknown>,
  ctx: MethodContext,
) => Promise<unknown> | unknown;
```

In `createDaemon`, replace the connection handler body with:

Keep the `const instance = …; server = instance;` shape from Task 10 — the local is
what lets `listen` avoid a non-null assertion, which `src/` forbids.

```ts
      const instance = createServer((sock) => {
        sockets.add(sock);
        const closeCallbacks: Array<() => void> = [];
        const ctx: MethodContext = {
          notify(method, params) {
            if (!sock.destroyed) {
              sock.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
            }
          },
          onClose(cb) {
            closeCallbacks.push(cb);
          },
        };
        const cleanup = (): void => {
          sockets.delete(sock);
          for (const cb of closeCallbacks) cb();
          closeCallbacks.length = 0;
        };
        sock.on('data', createFrameDecoder((msg) => void handle(sock, msg, ctx)));
        sock.on('close', cleanup);
        sock.on('error', cleanup);
      });
```

And change the `handle` signature and its handler call:

```ts
  async function handle(sock: Socket, msg: unknown, ctx: MethodContext): Promise<void> {
```

```ts
      const result = await handler(req.params ?? {}, ctx);
```

- [ ] **Step 4: Implement `src/daemon/runtime.ts`**

```ts
import { CrossweaveError } from '../core/errors.js';
import type { AgentAdapter, AgentProcess } from '../adapters/types.js';
import type { SessionRow } from '../db/repositories/session.js';
import type { MethodContext } from './server.js';

const SCROLLBACK_LIMIT = 64 * 1024;

/** How long an agent gets to honour SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 3000;

/**
 * One broken subscriber must not starve the others, and must never be able to stop
 * the runtime's own bookkeeping from running.
 */
function notifyAll(
  subscribers: Iterable<MethodContext>,
  method: string,
  params: unknown,
): void {
  for (const sub of subscribers) {
    try {
      sub.notify(method, params);
    } catch {
      // The subscriber owns its failure; the stream keeps going.
    }
  }
}

interface RunningSession {
  proc: AgentProcess;
  scrollback: string;
  subscribers: Set<MethodContext>;
}

export class SessionRuntime {
  private readonly running = new Map<string, RunningSession>();

  constructor(private readonly onExit: (sessionId: string, code: number) => void) {}

  start(session: SessionRow, adapter: AgentAdapter): number {
    if (this.running.has(session.id)) {
      throw new CrossweaveError('SESSION_ALREADY_RUNNING', `Session already running: ${session.name}`);
    }
    if (session.worktreePath === null) {
      throw new CrossweaveError('SESSION_NO_WORKDIR', `Session has no working directory: ${session.name}`);
    }

    const proc = adapter.spawn({
      cwd: session.worktreePath,
      env: { CW_SESSION_ID: session.id, CW_SESSION_NAME: session.name },
      cols: 80,
      rows: 24,
    });

    const entry: RunningSession = { proc, scrollback: '', subscribers: new Set() };
    this.running.set(session.id, entry);

    proc.onData((chunk) => {
      entry.scrollback = (entry.scrollback + chunk).slice(-SCROLLBACK_LIMIT);
      notifyAll(entry.subscribers, 'session.data', { sessionId: session.id, chunk });
    });

    proc.onExit((code) => {
      // Bookkeeping BEFORE notifying, deliberately. A throwing subscriber used to
      // abort this callback, so `running` never lost its entry and `onExit` never
      // ran: the session stayed wedged at `running` with a stale pid and could never
      // be started again. Task 7 isolated the ADAPTER's fan-out; this loop is a
      // second one and needed the same treatment.
      this.running.delete(session.id);
      this.onExit(session.id, code);
      notifyAll(entry.subscribers, 'session.exit', { sessionId: session.id, code });
    });

    return proc.pid;
  }

  private require(sessionId: string, name: string): RunningSession {
    const entry = this.running.get(sessionId);
    if (!entry) {
      throw new CrossweaveError('SESSION_NOT_RUNNING', `Session is not running: ${name}`);
    }
    return entry;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  write(sessionId: string, name: string, data: string): void {
    this.require(sessionId, name).proc.write(data);
  }

  resize(sessionId: string, name: string, cols: number, rows: number): void {
    this.require(sessionId, name).proc.resize(cols, rows);
  }

  subscribe(sessionId: string, name: string, ctx: MethodContext): void {
    const entry = this.require(sessionId, name);
    entry.subscribers.add(ctx);
    ctx.onClose(() => entry.subscribers.delete(ctx));
    if (entry.scrollback.length > 0) {
      ctx.notify('session.data', { sessionId, chunk: entry.scrollback });
    }
  }

  /**
   * Signal the agent and wait until it is actually gone, escalating if it ignores
   * SIGTERM.
   *
   * Returning before the process has died is what let `resume` immediately after
   * `stop` see a still-live pty, short-circuit on `isRunning`, and report success
   * carrying a pid that was already dead — with the whole suite passing even when
   * `resume`'s restart path was gutted. It is the same gap that let `kill` clear the
   * pid while the process survived, stranding an agent with no record of it.
   */
  async stop(sessionId: string, graceMs = STOP_GRACE_MS): Promise<void> {
    const entry = this.running.get(sessionId);
    if (!entry) return;

    // A listener registered after the process already exited still fires, so this
    // cannot miss the event (proven by Task 7's late-onExit test).
    const exited = new Promise<void>((resolve) => {
      entry.proc.onExit(() => resolve());
    });

    entry.proc.kill('SIGTERM');
    const escalate = setTimeout(() => entry.proc.kill('SIGKILL'), graceMs);
    try {
      await exited;
    } finally {
      clearTimeout(escalate);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}
```

- [ ] **Step 5: Add adapter injection to `src/domain/session.ts`**

Change the import and constructor:

```ts
import { createAdapter as defaultCreateAdapter } from '../adapters/registry.js';
import type { AgentAdapter } from '../adapters/types.js';

export type AdapterFactory = (kind: string) => AgentAdapter;
```

```ts
  constructor(
    db: Database,
    private readonly adapterFactory: AdapterFactory = defaultCreateAdapter,
  ) {
    this.sessions = new SessionRepo(db);
    this.workspaces = new WorkspaceRepo(db);
  }
```

Inside `create`, replace `const adapter = createAdapter(opts.agent);` with:

```ts
    const adapter = this.adapterFactory(opts.agent);
```

Add a public accessor so the method table can build an adapter when starting:

```ts
  adapterFor(kind: string): AgentAdapter {
    return this.adapterFactory(kind);
  }

  markStatus(id: string, status: SessionRow['status'], pid: number | null): void {
    this.sessions.updateStatus(id, status, pid);
  }

  /**
   * The agent process ended. Called from the runtime's ASYNCHRONOUS exit handler, so
   * it must not clobber a terminal state that a synchronous caller already wrote:
   * `kill()` sets `dead` immediately after SIGTERM, and the pty's exit callback lands
   * afterwards. Without this guard a killed session reads back as `idle` and
   * `cw session list` lies about it.
   */
  clearRunning(id: string): void {
    const row = this.sessions.findById(id);
    if (!row) return;
    if (row.status === 'dead' || row.status === 'landed') return;
    this.sessions.updateStatus(id, 'idle', null);
  }
```

Add `SessionRuntime` awareness to `kill` so a running agent is stopped through the
runtime rather than a bare `process.kill`. Replace the `if (row.pid !== null)` block with:

```ts
    // Awaited: kill must not report success while the agent is still alive, and the
    // pid must not be cleared until the process is confirmed gone — otherwise nothing
    // can ever find or reap it again.
    await this.onKill?.(row.id);
```

and add to the class:

```ts
  /** Set by the daemon so kill() can stop a live pty it does not own. */
  onKill?: (sessionId: string) => Promise<void>;
```

- [ ] **Step 6: Extend `src/daemon/methods.ts`**

Replace the signature and add the runtime methods:

```ts
export function buildMethods(
  db: Database,
  projectRoot: string,
  adapterFactory?: AdapterFactory,
): Record<string, MethodHandler> {
  const workspaces = new WorkspaceManager(db);
  const sessions = new SessionManager(db, adapterFactory);
  const runtime = new SessionRuntime((sessionId) => {
    sessions.clearRunning(sessionId);
  });
  sessions.onKill = (id) => runtime.stop(id);
  // NOTE: the runtime only knows processes THIS daemon started. After a daemon
  // restart the row can still carry a pid from the previous one, and killing such a
  // session signals nothing. Signalling the stale pid directly is NOT safe — pids are
  // reused, and we would be signalling an unrelated process. Reconciliation on daemon
  // start (M2) is what closes this; it is recorded as a known M0 limitation.

  /**
   * `dead` and `landed` are terminal. The API already carries two distinct verbs —
   * `session.stop` ends the agent process and leaves the session `idle` and
   * resumable, `session.kill` ends the session — and if a killed session could be
   * started again the two would be the same thing and the status column would mean
   * nothing. The worktree outliving a kill is for inspecting the work and landing it
   * later, not for resurrecting the session.
   */
  function assertResumable(row: SessionRow): void {
    if (row.status === 'dead' || row.status === 'landed') {
      throw new CrossweaveError(
        'SESSION_ENDED',
        `Session ${row.name} is ${row.status} and cannot be started again. ` +
          'Use `cw session stop` for a session you intend to resume, or create a new one.',
      );
    }
  }

  function start(p: Record<string, unknown>): SessionRow {
    const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
    assertResumable(row);
    const pid = runtime.start(row, sessions.adapterFor(row.agentKind));
    sessions.markStatus(row.id, 'running', pid);
    return sessions.resolve(row.workspaceId, row.id);
  }

  return {
    // ...existing entries unchanged...

    'session.start': (p) => start(p),

    'session.resume': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      // Checked BEFORE isRunning: right after a kill the runtime still reports the
      // pty as running until its exit callback lands, and returning the row there
      // handed back a stale `dead` snapshot with no error at all.
      assertResumable(row);
      if (runtime.isRunning(row.id)) return row;
      return start(p);
    },

    'session.attach': (p, ctx) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      runtime.subscribe(row.id, row.name, ctx);
      return { ok: true, sessionId: row.id, name: row.name };
    },

    'session.input': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      runtime.write(row.id, row.name, str(p, 'data'));
      return { ok: true };
    },

    'session.resize': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      runtime.resize(row.id, row.name, num(p, 'cols'), num(p, 'rows'));
      return { ok: true };
    },

    // Awaited, so a caller told the session stopped can trust that it actually is.
    'session.stop': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      await runtime.stop(row.id);
      return { ok: true };
    },

    'daemon.shutdown': async () => {
      await runtime.stopAll();
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },
  };
}
```

Add the numeric param helper alongside `str`/`bool`:

```ts
function num(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v !== 'number') {
    throw new CrossweaveError('INVALID_PARAMS', `Expected number param: ${key}`);
  }
  return v;
}
```

Add the imports this needs at the top of the file:

```ts
import { CrossweaveError } from '../core/errors.js';
import { SessionRuntime } from './runtime.js';
import type { AdapterFactory } from '../domain/session.js';
import type { SessionRow } from '../db/repositories/session.js';
```

- [ ] **Step 7: Add notification support to `src/client/rpc-client.ts`**

Add a field and method to `DaemonClient`:

```ts
  private readonly notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(cb);
  }
```

In the constructor's frame handler, dispatch id-less frames before the pending lookup:

```ts
        const r = msg as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { message: string; data?: { code?: string } };
        };
        if (typeof r.id !== 'number') {
          if (typeof r.method === 'string') {
            for (const h of this.notificationHandlers) h(r.method, r.params);
          }
          return;
        }
```

- [ ] **Step 8: Run the runtime tests and typecheck**

Run: `bun test tests/daemon/runtime.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 9: Implement `src/cli/commands/attach.ts`**

```ts
import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';

/**
 * Ctrl-]. Written as an escape, never as a literal control byte: an invisible 0x1D
 * in a code block does not survive transcription, and when it was lost this became
 * an empty string — `''.includes('')` is true, so the first keystroke detached and
 * no input ever reached the agent.
 *
 * Compared with `===` rather than `includes` so a 0x1D inside a paste does not
 * detach; a real keypress arrives as its own chunk.
 */
export const DETACH_KEY = '\x1d';

export const attachCommand = defineCommand({
  meta: { name: 'attach', description: 'Attach the terminal to a running session (Ctrl-] to detach)' },
  args: {
    target: { type: 'positional', description: 'Session name or id' },
    start: { type: 'boolean', default: true, description: 'Start the agent if it is not running' },
  },
  async run({ args }) {
    const stdin = process.stdin;
    const isTty = stdin.isTTY === true;

    // Last-resort guard, registered before anything can fail. A terminal left in raw
    // mode gives the user a shell that neither echoes nor answers Ctrl-C, recoverable
    // only from another window with `stty sane`.
    process.once('exit', () => {
      if (isTty) stdin.setRawMode(false);
    });

    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const target = { workspaceId, idOrName: args.target };

        if (args.start) await client.call('session.resume', target);
        // Subscribe exactly ONCE and await it. This used to run a second time inside
        // the promise with its failure swallowed, which both replayed the scrollback
        // twice and could leave the terminal raw and attached to nothing.
        await client.call('session.attach', target);

        await new Promise<void>((resolve) => {
          let done = false;

          const onResize = (): void => {
            void client.call('session.resize', {
              ...target,
              cols: process.stdout.columns ?? 80,
              rows: process.stdout.rows ?? 24,
            }).catch(() => undefined);
          };

          const onInput = (buf: Buffer): void => {
            const data = buf.toString('utf8');
            if (data === DETACH_KEY) {
              process.stdout.write('\n[detached]\n');
              finish();
              return;
            }
            void client.call('session.input', { ...target, data }).catch(() => undefined);
          };

          function finish(): void {
            if (done) return;
            done = true;
            if (isTty) stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onInput);
            process.removeListener('SIGWINCH', onResize);
            resolve();
          }

          client.onNotification((method, params) => {
            if (method === 'session.data') {
              process.stdout.write((params as { chunk: string }).chunk);
            } else if (method === 'session.exit') {
              process.stdout.write('\n[session exited]\n');
              finish();
            }
          });

          // Without this, finish() was reachable only from session.exit or Ctrl-] —
          // neither of which can fire once the socket is gone — so a daemon that died
          // left the CLI hung with the terminal in raw mode.
          client.onClose(() => {
            process.stdout.write('\n[daemon connection lost]\n');
            finish();
          });

          onResize();
          process.on('SIGWINCH', onResize);
          if (isTty) stdin.setRawMode(true);
          stdin.resume();
          stdin.on('data', onInput);
        });
      });
    } catch (err) { fail(err); }
  },
});
```

- [ ] **Step 10: Register attach as a `session` subcommand**

This is entirely in `src/cli/commands/session.ts` — `src/cli/index.ts` already wires
`session` into the root command and needs no change. Add to the `subCommands` object
of `sessionCommand`:

```ts
    attach: attachCommand,
```

with `import { attachCommand } from './attach.js';` at the top of that file.

- [ ] **Step 11: Add the CLI-level attach error test**

Append to `tests/cli/cli.test.ts`:

```ts
  it('attach reports a clear error for an unknown session', async () => {
    await cw(['init']);
    const r = await cw(['session', 'attach', 'ghost']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('SESSION_NOT_FOUND');
  }, 30_000);
```

The interactive attach path is covered at the daemon and client level in
`tests/daemon/runtime.test.ts`, where input, output streaming, scrollback replay and
exit are all asserted. Driving a raw-mode tty through the CLI in a test adds harness
complexity without adding coverage of the logic, so it is deliberately not tested here.

- [ ] **Step 12: Build, run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all PASS, 0 type errors.

- [ ] **Step 13: Commit**

```bash
git add src/daemon/runtime.ts src/daemon/server.ts src/daemon/methods.ts src/domain/session.ts src/client/rpc-client.ts src/cli tests/daemon/runtime.test.ts tests/cli/cli.test.ts
git commit -m "feat(runtime): run agents in daemon-owned ptys with attach, resume and stop"
```

---

### Task 14: Single-binary packaging

The reason this project is on Bun. Competing tools ship a binary; requiring users to
install a runtime first is an adoption tax, so distribution is built in M0 rather than
left as polish.

**Files:**
- Create: `scripts/build.ts`
- Create: `src/core/version.ts`
- Modify: `src/client/rpc-client.ts` — locate the sibling `cwd` binary when compiled
- Modify: `src/cli/index.ts` — `--version`
- Test: `tests/packaging/binary.test.ts`

**Interfaces:**
- Consumes: `connectOrStart` (Task 11)
- Produces: `VERSION: string`, `resolveDaemonEntry(): string`

- [ ] **Step 1: Write the failing test**

Create `tests/packaging/binary.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitFixture } from '../helpers/git-fixture.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cwBin = join(root, 'dist', 'cw');
const cwdBin = join(root, 'dist', 'cwd');

beforeAll(async () => {
  const proc = Bun.spawn(['bun', 'run', 'scripts/build.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
}, 180_000);

describe('compiled binaries', () => {
  it('produces both executables', () => {
    expect(existsSync(cwBin)).toBe(true);
    expect(existsSync(cwdBin)).toBe(true);
  });

  it('reports its version without any runtime installed alongside it', async () => {
    const proc = Bun.spawn([cwBin, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('runs a real workspace lifecycle from the binary alone', async () => {
    const fx = await makeGitFixture();
    try {
      const init = Bun.spawn([cwBin, 'init'], { cwd: fx.root, stdout: 'pipe', stderr: 'pipe' });
      expect(await init.exited).toBe(0);
      expect(existsSync(join(fx.root, '.crossweave', 'state.db'))).toBe(true);

      const list = Bun.spawn([cwBin, 'session', 'list'], { cwd: fx.root, stdout: 'pipe', stderr: 'pipe' });
      expect(await new Response(list.stdout).text()).toContain('no sessions');
      expect(await list.exited).toBe(0);

      Bun.spawn([cwBin, 'daemon', 'stop'], { cwd: fx.root, stdout: 'ignore', stderr: 'ignore' });
    } finally {
      await fx.cleanup();
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/packaging/binary.test.ts`
Expected: FAIL — `scripts/build.ts` does not exist.

- [ ] **Step 3: Implement `src/core/version.ts`**

```ts
import pkg from '../../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
```

- [ ] **Step 4: Implement `scripts/build.ts`**

```ts
import { rm, mkdir } from 'node:fs/promises';

const targets = [
  { entry: './src/cli/index.ts', out: './dist/cw' },
  { entry: './src/daemon/main.ts', out: './dist/cwd' },
];

await rm('./dist', { recursive: true, force: true });
await mkdir('./dist', { recursive: true });

for (const t of targets) {
  const proc = Bun.spawn(
    ['bun', 'build', t.entry, '--compile', '--minify', '--outfile', t.out],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`build failed for ${t.entry}`);
    process.exit(code);
  }
}

console.log('built dist/cw and dist/cwd');
```

- [ ] **Step 5: Teach the client to find the daemon when compiled**

In `src/client/rpc-client.ts`, replace the default parameter with an explicit resolver.
A compiled `cw` cannot spawn `../daemon/main.ts` — that source path does not exist on a
user's machine — so it spawns the `cwd` binary sitting next to it instead.

```ts
import { basename, dirname, join } from 'node:path';

/**
 * Compiled binaries run as `cw`; from source, `process.execPath` is the bun binary.
 * The two cases need different daemon entry points and different spawn arguments.
 */
export function resolveDaemonEntry(): { command: string; args: string[] } {
  const isCompiled = basename(process.execPath).startsWith('cw');
  if (isCompiled) {
    return { command: join(dirname(process.execPath), 'cwd'), args: [] };
  }
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('../daemon/main.ts', import.meta.url))],
  };
}
```

Change `connectOrStart` to use it:

```ts
export async function connectOrStart(
  projectRoot: string,
  entry = resolveDaemonEntry(),
): Promise<DaemonClient> {
  const socketPath = join(crossweaveDir(projectRoot), 'daemon.sock');

  try {
    return await DaemonClient.connect(socketPath);
  } catch {
    // Nothing listening; start one below.
  }

  const child = spawn(entry.command, entry.args, {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
```

The rest of the function is unchanged. Update the one call site in
`tests/client/rpc-client.test.ts` that passed a path — it now passes nothing, since the
default already resolves correctly from source.

- [ ] **Step 6: Add `--version` to `src/cli/index.ts`**

```ts
import { VERSION } from './core/version.js';
```

and in the `main` command definition:

```ts
  meta: { name: 'cw', version: VERSION, description: 'crossweave — parallel agents that stay mergeable' },
```

- [ ] **Step 7: Run the packaging test**

Run: `bun test tests/packaging/binary.test.ts && bun run typecheck`
Expected: all PASS, 0 type errors. Note the binary sizes printed by the build — a
crossweave binary should land in the tens of megabytes; a sharp jump would mean
something native crept into the dependency graph.

- [ ] **Step 8: Run the whole suite**

Run: `bun test && bun run typecheck`
Expected: all PASS across every test file, 0 type errors.

- [ ] **Step 9: Commit**

```bash
git add scripts src/core/version.ts src/client/rpc-client.ts src/cli/index.ts tests/packaging
git commit -m "feat(packaging): compile cw and cwd to standalone binaries"
```

---

## M0 Definition of Done

- `bun run build && bun test && bun run typecheck` is green.
- In a real repository: `cw init`, `cw session new --name auth --agent claude`, `cw session list`, `cw session attach auth`, `cw session kill auth --rm-worktree --yes` all work.
- `cw session attach` puts you in a live Claude Code session running inside that session's worktree, and Ctrl-] detaches without killing the agent.
- Two sessions get two worktrees and writes in one are invisible in the other.
- Every error path exits non-zero with a stable `CODE: message` line on stderr.
- The daemon starts on demand and stops cleanly with `cw daemon stop`, killing any agents it owns.
- `bun install` pulls exactly two packages, runs no postinstall script and invokes no compiler.
- `bun run build` produces `dist/cw` and `dist/cwd`, and `dist/cw init` works on a machine with no Bun and no Node installed.
- The daemon socket is `0600` and `.crossweave/` is `0700`.

## Deferred to later milestones (explicitly not in M0)

Reconciliation on daemon start (M2 — needs the event ledger; until then a daemon crash leaves session rows claiming `running` with a stale pid), resource leases and disk guard (M1), Collision Radar (M3), Convergence Engine and `cw land` (M4), ACP and enforced Safe Mode (M5), TUI (M6).

Two known M0 limitations, both accepted rather than hidden: attaching from more than one terminal at once shares one pty with no per-client sizing, and the pty starts at a fixed 80×24 until the first attach resizes it.

`cw workspace switch` is intentionally absent: a workspace is identified by the repository you are standing in, so `cd` is the switch. It is reconsidered only if the TUI in M6 needs a cross-repository view.
