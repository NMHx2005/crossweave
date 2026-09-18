import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crossweaveDir } from '../core/paths.js';
import { mcpSocketPath } from '../mcp/protocol.js';

/**
 * The OS boundary around a session process — the one mechanism here that does not
 * depend on the agent's cooperation.
 *
 * Why it exists: T1/T2/T3 intercept tool calls an agent REPORTS, so a write made
 * through a shell or a subprocess slips past all of them. This confines the process
 * itself. Full reasoning and the measurements behind the profile:
 * `docs/superpowers/specs/2026-09-18-os-sandbox-design.md`.
 *
 * The design was measured before it was written, and the measurements changed it:
 * a linked worktree's gitdir lives in the MAIN repo's `.git`, so the naive
 * "everything outside the worktree is read-only" breaks every commit; and a
 * `(deny default)` profile blocks `connect()` on a unix socket even though the
 * socket is a file, so the daemon the agent's hooks must reach needs its own
 * explicit outbound rule. The rules below are the narrowest set verified to let a
 * real session run (`git commit` works, the hooks reach the daemon) while every
 * escape attempt in the spec's table was refused.
 */

/**
 * What a session needs a boundary built around. Deliberately NOT the command line:
 * every adapter knows its own argv (`--settings`, `--trust agent acp`, …) and builds
 * the final `sandbox-exec` invocation itself, so the daemon passes this through
 * `SpawnOptions` and the adapter calls `planSandbox` with its own command at spawn.
 */
export interface SandboxSpec {
  /** The session's worktree. Everything else on disk is read-only. */
  worktreePath: string;
  /** The main repo root; its `.git` is shared with the worktree. */
  projectRoot: string;
  /** Opt-in network access (`sandbox.network` in crossweave.config.json). */
  network: boolean;
  /** Session id: names the profile file and the private temp dir. */
  sessionId: string;
  /** The branch the worktree is on — the one ref the profile opens up. */
  branch?: string;
  /** Test seams; both default to the real host. */
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * What a session just created and resumable carries. Kept as plain fields rather than
 * a `SessionRow` import so this module stays a leaf — nothing here should pull the DB
 * into the spawn path.
 */
export interface SandboxRequest {
  enabled: boolean;
  network: boolean;
  projectRoot: string;
  worktreePath: string | null;
  branch: string | null;
  sessionId: string;
  platform?: NodeJS.Platform;
}

/** Why a requested sandbox was not built, in words a log line can print. */
export type SandboxSkip = 'disabled' | 'no-worktree' | 'no-provider';

export interface SandboxDecision {
  spec?: SandboxSpec;
  /** Present exactly when `spec` is absent and the workspace asked for a sandbox. */
  skip?: SandboxSkip;
}

/**
 * Decide WHETHER this session gets a boundary, and say which way it went.
 *
 * Three outcomes, not two, on purpose. A workspace with `sandbox.enabled: true` on a
 * platform without a provider, or on a `--no-worktree` session that shares the main
 * checkout, runs unconfined — and the caller that stays silent about that is the
 * caller that lets a user believe a boundary exists. The CLI's coverage labels and
 * this decision come from the same place for the same reason
 * (`src/adapters/coverage.ts`): the UI must not be able to drift from the truth.
 */
export function decideSandbox(req: SandboxRequest): SandboxDecision {
  if (!req.enabled) return { skip: 'disabled' };
  if (req.worktreePath === null) return { skip: 'no-worktree' };
  if (!isSandboxAvailable(req.platform ?? process.platform)) return { skip: 'no-provider' };
  return {
    spec: {
      worktreePath: req.worktreePath,
      projectRoot: req.projectRoot,
      network: req.network,
      sessionId: req.sessionId,
      ...(req.branch === null ? {} : { branch: req.branch }),
    },
  };
}

export interface SandboxPlan {
  /** Command and arguments to spawn: `sandbox-exec -f <profile> <agent...>`. */
  argv: string[];
  /** Paths the profile grants write access to, for the log line and for tests. */
  writable: string[];
  /** Remove the generated profile file. Safe to call more than once. */
  cleanup: () => void;
}

/** macOS ships this; nothing else has it. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The sandbox's private temp root, so a session's `TMPDIR` writes stay inside it. */
export function sandboxTmpDir(projectRoot: string, sessionId: string): string {
  return join(projectRoot, '.crossweave', 'sandbox-tmp', sessionId);
}

/**
 * State the CLI agents keep in the home directory. Named explicitly so the REST of
 * the home directory stays read-only, which is the point of the exercise.
 */
function agentStatePaths(home: string): string[] {
  return [join(home, '.claude'), join(home, '.claude.json')];
}

/**
 * The unix sockets a session is a CLIENT of: the daemon's own (`cw radar-hook` runs
 * as a grandchild of the agent and connects on every tool call), and the session's
 * MCP socket.
 *
 * These are not files to be written — they are `connect()` targets, and seatbelt
 * gates `connect()` under `network-outbound`, not `file-write*`. Verified: with a
 * bare `(deny default)` the connection is refused with EPERM; one
 * `(allow network-outbound (remote unix-socket (literal …)))` clause restores it
 * while outbound TCP to the internet stays denied (`curl` rc=6).
 */
function sessionSocketPaths(projectRoot: string, sessionId: string): string[] {
  return [join(crossweaveDir(projectRoot), 'daemon.sock'), mcpSocketPath(sessionId)]
    // seatbelt matches the CANONICAL path, and macOS `$TMPDIR` is handed out through
    // `/var` (a symlink to `/private/var`), so an uncanonicalised literal silently
    // fails to match. `dirname` already exists by the time a session starts (the
    // daemon created it), so this resolves rather than throwing.
    .map((p) => {
      try {
        return realpathSync(p);
      } catch {
        try {
          return join(realpathSync(dirname(p)), p.slice(dirname(p).length + 1));
        } catch {
          return p;
        }
      }
    });
}

/**
 * Anything under the object store that git must be able to create. Built from
 * hyphen-free character classes and explicit repetition: macOS `sandbox-exec` refuses
 * a `-` inside a class, which is what made the first version of this file fail to
 * parse at all.
 */
function objectStoreRules(gitDir: string): string[] {
  const objects = `${gitDir}/objects/`;
  const H2 = '[0-9a-f][0-9a-f]';
  const H38 = '[0-9a-f]'.repeat(38);
  return [
    // New loose objects. Create+data only — git never rewrites an existing object, so
    // omitting unlink means an existing object cannot be deleted or replaced.
    `(allow file-write-create file-write-data (regex "^${objects}${H2}/${H38}$"))`,
    // The fanout directory itself. Missing this is what made an earlier version fail
    // at `git commit` with a bare "unable to create temporary file".
    `(allow file-write-create (regex "^${objects}${H2}$"))`,
    // Temporary object files, which git creates and then unlinks.
    `(allow file-write-create file-write-data file-write-unlink (regex "^${objects}${H2}/tmp_obj_[A-Za-z0-9]+$"))`,
    `(allow file-write-create file-write-data (regex "^${objects}pack/[A-Za-z0-9._]*$"))`,
    `(allow file-write-create file-write-data (regex "^${objects}info/[A-Za-z0-9._]*$"))`,
  ];
}

/**
 * The shared `.git` a worktree commits through. The worktree's bookkeeping directory
 * is derived from the gitdir rather than reconstructed from the worktree's basename,
 * because the two do not always match.
 */
function sharedGitRules(gitDir: string, branch: string): string[] {
  const rules = objectStoreRules(gitDir);
  const worktreesDir = `${gitDir}/worktrees`;
  if (existsSync(worktreesDir)) {
    rules.push(`(allow file-write-create file-write-data file-write-unlink (subpath "${worktreesDir}"))`);
  }
  // This session's own branch ref, and only it. create+data+unlink is what git's
  // create-.lock-then-rename dance needs; without unlink, `git commit` cannot finish.
  if (branch !== '') {
    const ref = `${gitDir}/refs/heads/${branch}`;
    rules.push(`(allow file-write-create file-write-data file-write-unlink (literal "${ref}") (literal "${ref}.lock"))`);
  }
  rules.push(
    `(allow file-write-create file-write-data file-write-unlink` +
    ` (literal "${gitDir}/packed-refs") (literal "${gitDir}/packed-refs.lock") (literal "${gitDir}/index.lock"))`,
  );
  rules.push(`(allow file-write-create file-write-data file-write-unlink (subpath "${gitDir}/logs"))`);
  return rules;
}

/** Whether this platform has a provider. Linux is specified but not built (spec §4). */
export function isSandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

/**
 * Build the argv to spawn the agent under, or `undefined` when no provider exists —
 * the caller then runs the agent as before and says so out loud, rather than
 * pretending a boundary is there.
 */
export function planSandbox(spec: SandboxSpec, command: string, args: string[]): SandboxPlan | undefined {
  const platform = spec.platform ?? process.platform;
  if (!isSandboxAvailable(platform)) return undefined;
  if (!existsSync(SANDBOX_EXEC)) {
    // Cannot happen on a stock macOS install, but a caller that asked for a boundary
    // and silently got none is exactly the failure this whole milestone exists to stop.
    process.stderr.write(
      `crossweave: ${SANDBOX_EXEC} is missing, so session ${spec.sessionId} runs WITHOUT an OS sandbox.\n`,
    );
    return undefined;
  }

  const home = spec.home ?? homedir();
  const tmpRoot = sandboxTmpDir(spec.projectRoot, spec.sessionId);
  mkdirSync(tmpRoot, { recursive: true });

  const profile = buildSeatbeltProfile(spec, home, tmpRoot);
  const profilePath = join(tmpdir(), `cw-sandbox-${spec.sessionId}.sb`);
  writeFileSync(profilePath, profile, 'utf8');

  return {
    argv: [SANDBOX_EXEC, '-f', profilePath, command, ...args],
    writable: [realpathSync(spec.worktreePath), tmpRoot, ...agentStatePaths(home)],
    cleanup: () => {
      try {
        rmSync(profilePath, { force: true });
        // The session's private temp dir too, or every stopped-then-resumed session
        // would leave one behind; `planSandbox` recreates it on the next start.
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // Best effort: the profile holds no private data, and a leftover temp dir or
        // file in the system temp dir is not worth failing a session teardown over.
      }
    },
  };
}

/**
 * The seatbelt profile. Exported so tests can assert on the clauses themselves: a
 * profile is only as good as what it denies, and that is invisible from a passing
 * test of the spawn path.
 */
export function buildSeatbeltProfile(spec: SandboxSpec, home: string, tmpRoot: string): string {
  const worktree = realpathSync(spec.worktreePath);
  const gitDir = resolveGitDir(spec.worktreePath);
  const branch = spec.branch ?? resolveBranch(spec.worktreePath);

  const writeRules = [
    `(allow file-write* (subpath "${worktree}"))`,
    `(allow file-write* (subpath "${tmpRoot}"))`,
    // The one cache a runtime legitimately owns. Deliberately NOT /tmp, NOT
    // /private/tmp, and NOT /private/var/folders: that last one is the OS temp root
    // every process on the machine shares, and granting it made every escape probe
    // below succeed — a blanket grant that also happens to be unnecessary. Measured
    // without it: a real `claude` session, `node`, `bun` and a sandboxed `git commit`
    // all work, because the session's `TMPDIR` points at its own temp dir instead
    // (see SessionRuntime.start).
    `(allow file-write* (subpath "${home}/Library/Caches"))`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")' +
      ' (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    ...agentStatePaths(home).flatMap((p) => [
      `(allow file-write* (literal "${p}") (subpath "${p}"))`,
    ]),
  ];

  // Client-side unix sockets. `remote unix-socket` is the seatbelt term for the far
  // end of a `connect()`; a literal path per socket, so opening an unrelated socket
  // anywhere else is still refused.
  const socketRules = sessionSocketPaths(spec.projectRoot, spec.sessionId).flatMap((p) => [
    `(allow network-outbound (remote unix-socket (literal "${p}")))`,
  ]);

  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    ...writeRules,
    ...(gitDir === undefined ? [] : sharedGitRules(gitDir, branch)),
    ...socketRules,
    // The login keychain. Without these, a sandboxed `claude` reports "Not logged in":
    // its login state lives in the keychain rather than a file (measured), and a
    // logged-out sandbox is worse for the user than no sandbox at all.
    '(allow mach-lookup',
    '  (global-name "com.apple.SecurityServer")',
    '  (global-name "com.apple.securityd")',
    '  (global-name "com.apple.system.opendirectoryd.libinfo")',
    '  (global-name "com.apple.system.opendirectoryd.membership"))',
    ...(spec.network ? ['(allow network*)'] : []),
    '',
  ].join('\n');
}

/**
 * The main repo's `.git`, resolved by git itself from the worktree. `--git-common-dir`
 * rather than `--git-dir`: a linked worktree's own gitdir is the per-worktree
 * subdirectory, while the object store and refs live in the common one.
 */
export function resolveGitDir(worktreePath: string): string | undefined {
  try {
    const out = execFileSync(
      'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/** The worktree's current branch, for the one ref the profile opens up. */
export function resolveBranch(worktreePath: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}
