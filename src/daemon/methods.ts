import type { Database } from 'bun:sqlite';
import { execFile, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager } from '../domain/workspace.js';
import { SessionManager, type AdapterFactory } from '../domain/session.js';
import { CrossweaveError } from '../core/errors.js';
import { SessionRuntime } from './runtime.js';
import type { MethodHandler } from './server.js';
import { SessionRepo, type SessionRow } from '../db/repositories/session.js';
import { LeaseManager } from '../isolation/leases/manager.js';
import { loadConfig, type CrossweaveConfig } from '../core/config.js';
import { collectGarbage, collectOrphans } from '../domain/gc.js';
import { EventLedger } from '../domain/ledger.js';
import { reconcile } from '../domain/reconciliation.js';
import { assertContained } from '../core/paths.js';
import { ConvergenceScheduler } from './convergence-scheduler.js';
import { MergeTrialRepo, isPairwiseTrial } from '../db/repositories/merge-trial.js';
import { baseConflictFiles, commitsAhead } from '../convergence/trial.js';
import { sessionDiff } from '../domain/session-diff.js';
import { ConfigTrustRepo } from '../db/repositories/config-trust.js';
import { NotifyConfigRepo, type NotifyEventKind } from '../db/repositories/notify-config.js';
import { buildConflictGraph, recommendOrder } from '../convergence/graph.js';
import { classifyLandability } from '../convergence/evidence.js';
import { landSession } from '../convergence/land.js';
import { hashTestCommand, isTestCommandTrusted } from '../convergence/trust.js';
import { emptyJournal, normalizeTabs, readJournal, writeJournal } from '../domain/journal.js';
import { createChunkSealer } from '../gateway/e2e-sealer.js';

import { NotificationGate } from '../notify/gate.js';
import { notify, type NotifyDispatcherDeps } from '../notify/dispatcher.js';
import { platformSend } from '../notify/macos.js';
import { BroadcastRegistry } from './broadcast.js';
import { measureWorktrees } from '../isolation/disk-guard.js';
import { LeaseRepo } from '../db/repositories/lease.js';
import { spawnShell } from '../adapters/shell.js';
import { latestWords } from '../domain/agent-logs.js';
import { listWorktreeFiles, readWorktreeFile, writeWorktreeFile } from '../domain/worktree-files.js';
import { loadSettings, saveSettings, type UserSettings } from '../core/settings.js';
import { TerminalRegistry } from './terminals.js';

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

function num(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v !== 'number') {
    throw new CrossweaveError('INVALID_PARAMS', `Expected number param: ${key}`);
  }
  return v;
}

function optionalNum(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === 'number' ? v : undefined;
}

function optionalEventKind(params: Record<string, unknown>, key: string): NotifyEventKind | undefined {
  const v = params[key];
  if (v === 'land' || v === 'convergence') return v;
  return undefined;
}

/**
 * The daemon inherits the environment of whichever `cw` invocation happened to start
 * it, and by default every agent it spawns would get THAT environment forever —
 * stale toolchain, wrong virtualenv, whatever was exported when the daemon booted.
 * The client forwards its own `process.env` on every start/resume so the agent gets
 * the shell the user actually meant.
 */
/**
 * The base branch's HEAD, or `null` if it cannot be read — same tolerance as
 * `ConvergenceScheduler`'s own `baseHead()`. Callers report a degraded state
 * instead of failing: an unreadable HEAD is a legitimate repository condition
 * (an unborn branch, for one), not an internal fault.
 */
function readBaseHead(projectRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** The branch sessions land onto (the project's checked-out branch); null when detached. */
function readBaseBranch(projectRoot: string): string | null {
  try {
    const name = execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

function clientEnv(p: Record<string, unknown>): Record<string, string> {
  const raw = p.env;
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export function buildMethods(
  db: Database,
  projectRoot: string,
  adapterFactory?: AdapterFactory,
  config: CrossweaveConfig = loadConfig(projectRoot),
  opts: {
    startBackgroundJobs?: boolean;
    // Injected so tests can assert on notification call counts without spawning a
    // real terminal-notifier/osascript process — defaults to the real platform send.
    notifySend?: (title: string, message: string, clickCommand: string[] | undefined) => void;
    /** The Terminal pane's shell; defaults to $SHELL. Injected so tests run /bin/sh. */
    shell?: string;
  } = {},
): Record<string, MethodHandler> {
  const workspaces = new WorkspaceManager(db);
  // Constructed before `sessions` (SessionManager) deliberately: the default
  // adapterFactory closure below needs `sessionsRepo`/`fileClaims` already built —
  // both are cheap, stateless wrappers around `db`, so building them slightly earlier
  // than their other uses later in this function costs nothing.
  const sessionsRepo = new SessionRepo(db);
  const leasesRepo = new LeaseRepo(db);
  // A caller-supplied adapterFactory (every test) stands in for the session's shell.
  const sessions = new SessionManager(db, adapterFactory, config);
  const leaseManager = new LeaseManager(db, projectRoot, config);
  // Nothing a previous daemon held can have survived its death, and a lease left
  // marked active would permanently shrink the pool.
  leaseManager.releaseAll();

  const ledger = new EventLedger(db);
  const notifyGate = new NotificationGate();
  const configTrust = new ConfigTrustRepo(db);
  const notifyConfig = new NotifyConfigRepo(db);
  const notifyDeps: NotifyDispatcherDeps = {
    gate: notifyGate,
    isEnabled: (workspaceId, kind) => notifyConfig.isEnabled(workspaceId, kind),
    send: opts.notifySend ?? platformSend(),
  };
  // Lets any number of `daemon.subscribe`d connections (the TUI) receive
  // `tui.event`/`tui.invalidate` as they happen — see src/daemon/broadcast.ts's
  // own doc comment.
  const broadcastRegistry = new BroadcastRegistry();
  const convergenceScheduler = new ConvergenceScheduler(db, projectRoot, config, leaseManager, configTrust, notifyDeps, broadcastRegistry);
  // Constructed always, started only by the real daemon. Every test that calls
  // buildMethods() to exercise one RPC in isolation goes straight to db.close()
  // without daemon.shutdown, so an unconditional start() leaks a live 5s timer
  // into each of them — one that does real git work while the DB is still open.
  if (opts.startBackgroundJobs === true) convergenceScheduler.start();

  // Once, at boot: every `running`/`waiting` session in the DB is necessarily a
  // leftover from a previous daemon instance, since this one hasn't started
  // anything yet. See src/domain/reconciliation.ts for what this does and does not
  // catch.
  reconcile(db, projectRoot);

  // Sweep worktrees a previous daemon orphaned. ORPHANS ONLY, deliberately: `cw
  // session kill` without `--rm-worktree` leaves a session `dead` with its worktree
  // and branch intact because M4's `cw land` needs them, so reclaiming ended sessions
  // here would silently destroy that work on every restart, reboot and crash. The full
  // sweep belongs to `workspace.gc`, where the user asked for it.
  // Best effort: a daemon that cannot sweep must still start, or a stuck worktree
  // would make crossweave unusable.
  for (const ws of workspaces.list()) {
    void collectOrphans(db, ws.id).catch(() => undefined);
  }

  /**
   * `workspace.info`'s disk-usage figure is a synchronous, recursive filesystem walk
   * (`measureWorktrees` → `directorySize`, src/isolation/disk-guard.ts) that blocks
   * this single-threaded daemon for its whole duration. M1's original callers
   * (`assertDiskAvailable`, `cw gc`) invoked it rarely; the TUI (Task 4) now calls
   * this same handler on every `tui.invalidate` — after every session mutation,
   * including N times back-to-back during `L` (land-all)'s loop. A short TTL cache
   * per workspace id avoids re-walking the filesystem for calls that land within the
   * same window. 3000ms: long enough to absorb a burst of back-to-back invalidates
   * (a single land-all run, or several panes refreshing together) while still short
   * enough that `cw workspace info`/`cw workspace list` (which read this same
   * handler) never show a figure more than a few seconds stale. Lives for the
   * daemon process's lifetime, same as `notifyGate`/`broadcastRegistry` above.
   */
  const DISK_USAGE_CACHE_TTL_MS = 3000;
  const diskUsageCache = new Map<string, { value: { usedBytes: number; limitBytes: number }; computedAt: number }>();

  // E2E: session.data is sealed at source with the workspace's gateway key, so a
  // relay only ever forwards ciphertext. Resolved per session's workspace, not the
  // daemon's root, so a multi-workspace daemon uses each workspace's own key.
  const userHome = (): string => process.env.HOME || homedir();
  // Roots are cached: this runs per output chunk and a workspace's root never moves.
  const sealRoots = new Map<string, string>();
  const sealChunk = createChunkSealer((workspaceId) => {
    let root = sealRoots.get(workspaceId);
    if (root === undefined) {
      const ws = workspaces.list().find((w) => w.id === workspaceId);
      if (ws === undefined) throw new CrossweaveError('WORKSPACE_NOT_FOUND', `Unknown workspace: ${workspaceId}`);
      root = ws.rootPath;
      sealRoots.set(workspaceId, root);
    }
    return root;
  });
  const runtime = new SessionRuntime((sessionId) => {
    sessions.clearRunning(sessionId);
    leaseManager.release(sessionId);
    // A shell that exits on its own (`exit`, a crash) is a status change no RPC
    // announced; every client kept showing it `running` until something else redrew.
    broadcastRegistry.broadcast('tui.invalidate', {});
  }, sealChunk);
  sessions.onKill = (id) => runtime.stop(id);

  // Extra shells in a session's worktree (split panes), beside the session's own.
  const terminals = new TerminalRegistry((row) => spawnShell({
    shell: opts.shell ?? process.env.SHELL ?? '/bin/sh',
    cwd: row.worktreePath as string,
    env: { CW_SESSION_ID: row.id, CW_SESSION_NAME: row.name },
  }), sealChunk, () => broadcastRegistry.broadcast('tui.invalidate', {}));

  /** The worktree of the session a file RPC names; it must still be on disk. */
  function sessionWorktree(p: Record<string, unknown>): string {
    const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
    if (row.worktreePath === null || !existsSync(row.worktreePath)) {
      throw new CrossweaveError('SESSION_NO_WORKDIR', `Session has no working directory: ${row.name}`);
    }
    return row.worktreePath;
  }

  /** Close the shells of every session that no longer exists (its worktree is gone). */
  async function closeOrphanTerminals(workspaceId: string): Promise<void> {
    const live = new Set(sessions.list(workspaceId).map((s) => s.id));
    const orphaned = terminals.list(workspaceId).filter((t) => !live.has(t.sessionId));
    await Promise.all(orphaned.map((t) => terminals.close(t.terminalId)));
  }

  // `start` awaits `leaseManager.acquire` before `runtime.start` registers the
  // session as running, so two rapid `session.start`/`session.resume` RPCs for the
  // SAME session (the server dispatches each socket message via `void handle(...)`,
  // unserialized) can both pass their pre-checks and both land in that gap, each
  // acquiring a full lease block before the second `runtime.start` finally throws
  // SESSION_ALREADY_RUNNING. The check-and-mark below runs entirely synchronously,
  // before `start`'s first `await` — JS/Bun's single-threaded execution makes that
  // atomic, so no lock is needed, only removing the entry in `finally` so a throw
  // from either `acquire` or `runtime.start` cannot leave the session stuck
  // "starting" forever.
  const starting = new Set<string>();
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

  async function start(p: Record<string, unknown>): Promise<SessionRow> {
    const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
    assertResumable(row);
    // Synchronous check-and-mark, before the first `await` below: see the comment
    // on `starting` above for why this closes the concurrent-start race.
    if (starting.has(row.id)) {
      throw new CrossweaveError('SESSION_ALREADY_RUNNING', `Session already starting: ${row.name}`);
    }
    starting.add(row.id);
    try {
      // A lease must win over the client's shell, or a session's port would depend
      // on what the user happened to export.
      const env: Record<string, string> = { ...clientEnv(p), ...(await leaseManager.acquire(row.id)) };
      let pid: number;
      try {
        pid = runtime.start(row, sessions.adapterFor(row.agentKind), env);
      } catch (err) {
        // A spawn can fail synchronously (a missing $SHELL), after the lease block was
        // acquired above; without this release the block stays held for the daemon's
        // lifetime by a session that never ran.
        leaseManager.release(row.id);
        throw err;
      }
      sessions.markStatus(row.id, 'running', pid);
      ledger.append({ sessionId: row.id, workspaceId: row.workspaceId, kind: 'session.started', payload: '{}' });
      // Every client redraws on this. Without it, a session started by ANOTHER client
      // (the CLI while the cockpit is open) stayed `stopped` on every other screen.
      broadcastRegistry.broadcast('tui.invalidate', {});
      return sessions.resolve(row.workspaceId, row.id);
    } finally {
      starting.delete(row.id);
    }
  }

  return {
    ping: () => ({ ok: true }),

    'workspace.init': (p) => workspaces.init(projectRoot, optionalStr(p, 'name')),
    'workspace.list': () => workspaces.list(),
    // Enriched with disk usage at this RPC-handler layer, not inside
    // `WorkspaceManager.info()` — that domain method's `{workspace, sessions}` shape
    // stays the single source of truth other callers (tests, future non-TUI callers)
    // rely on; `measureWorktrees` (M1's Disk Guard, already the basis for
    // `assertDiskAvailable` and `collectGarbage`) is real, already-tested disk data,
    // not a placeholder.
    'workspace.info': (p) => {
      const id = str(p, 'id');
      const info = workspaces.info(id);
      const cached = diskUsageCache.get(id);
      const now = Date.now();
      let disk: { usedBytes: number; limitBytes: number };
      if (cached && now - cached.computedAt < DISK_USAGE_CACHE_TTL_MS) {
        disk = cached.value;
      } else {
        // `measureWorktrees` sums EVERY worktree, including the internal integration/
        // scratch session — correct for its original M1 callers (assertDiskAvailable,
        // collectGarbage), which legitimately want total-including-everything. A
        // user-facing figure must not, same as `info.sessions` itself already excludes
        // it (see WorkspaceManager.info()'s own filter) — so restrict the sum to the
        // session ids `info.sessions` actually shows the user, rather than changing
        // `measureWorktrees`'s own signature/behavior.
        const visibleIds = new Set(info.sessions.map((s) => s.id));
        const usedBytes = measureWorktrees(db, id)
          .filter((d) => visibleIds.has(d.sessionId))
          .reduce((sum, d) => sum + d.bytes, 0);
        disk = { usedBytes, limitBytes: config.disk.perWorkspaceBytes };
        diskUsageCache.set(id, { value: disk, computedAt: now });
      }
      return { ...info, disk };
    },
    'workspace.openFile': (p) => {
      const rel = str(p, 'path');
      // projectRoot is the source of truth — workspaceId is optional and ignored for now (single root daemon).
      const abs = join(projectRoot, rel);
      assertContained(projectRoot, abs);
      if (!existsSync(abs)) throw new CrossweaveError('NOT_FOUND', `Not found: ${rel}`);
      const content = readFileSync(abs, 'utf8').slice(0, 512*1024); // cap 512k
      return { path: rel, content };
    },
    'workspace.listFiles': (p) => {
      const prefix = typeof p.prefix === 'string' ? p.prefix : '';
      const dir = prefix === '' ? projectRoot : (() => { const d = join(projectRoot, prefix); assertContained(projectRoot, d); return d; })();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { throw new CrossweaveError('NOT_FOUND', `Not found: ${prefix || '.'}`); }
      const files = entries.map((e: { name: string; isDirectory: () => boolean }) => ({ name: e.name, isDirectory: e.isDirectory() }));
      return { prefix, files };
    },
    'workspace.delete': (p) => {
      workspaces.delete(str(p, 'id'), { force: bool(p, 'force', false) });
      return { ok: true };
    },
    'workspace.gc': async (p) => {
      const id = str(p, 'id');
      const result = await collectGarbage(db, id, { force: bool(p, 'force', false) });
      await closeOrphanTerminals(id);
      // Otherwise `workspace.info`'s disk figure (Important 3's TTL cache) can keep
      // showing pre-gc usage for up to `DISK_USAGE_CACHE_TTL_MS` after a gc, even
      // though the session list itself refreshes immediately via the broadcast below.
      diskUsageCache.delete(id);
      broadcastRegistry.broadcast('tui.invalidate', {});
      return result;
    },

    'session.new': (p) => {
      const row = sessions.create({
        workspaceId: str(p, 'workspaceId'),
        name: str(p, 'name'),
        worktree: bool(p, 'worktree', true),
        budgetTokens: optionalNum(p, 'budgetTokens'),
        budgetUsd: optionalNum(p, 'budgetUsd'),
        base: optionalStr(p, 'base'),
      });
      broadcastRegistry.broadcast('tui.invalidate', {});
      return row;
    },
    'session.list': (p) =>
      sessions.list(str(p, 'workspaceId')).map((session) => {
        // Whatever the user ran in this worktree last said, read from its own log
        // (Claude Code, Codex), found by the worktree path, not by what launched it.
        const words = session.worktreePath !== null && session.worktreePath !== projectRoot
          ? latestWords({ home: userHome(), cwd: session.worktreePath })
          : undefined;
        const withWords = { ...session, ...(words === undefined ? {} : { latestWords: words }) };
        const active = leasesRepo
          .listBySession(session.id)
          .filter((lease) => lease.releasedAt === null);
        if (active.length === 0) return withWords;
        const value = (kind: 'port' | 'docker' | 'cache' | 'db'): string | null =>
          active.find((lease) => lease.kind === kind)?.value ?? null;
        const port = value('port');
        return {
          ...withWords,
          leases: {
            portBase: port === null ? null : Number(port),
            composeProject: value('docker'),
            cachePath: value('cache'),
            dbStrategy: config.db.strategy,
            dbValue: value('db'),
          },
        };
      }),
    'session.rename': (p) =>
      sessions.rename(str(p, 'workspaceId'), str(p, 'idOrName'), str(p, 'newName')),
    'session.kill': async (p) => {
      const removeWorktree = bool(p, 'removeWorktree', false);
      // Killing keeps the worktree (it can still be landed), and a shell there is
      // still useful; only a kill that deletes it takes the shells first.
      if (removeWorktree) {
        await terminals.closeForSession(sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName')).id);
      }
      await sessions.kill(str(p, 'workspaceId'), str(p, 'idOrName'), { removeWorktree });
      broadcastRegistry.broadcast('tui.invalidate', {});
      return { ok: true };
    },
    'session.rm': async (p) => {
      await terminals.closeForSession(sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName')).id);
      await sessions.remove(str(p, 'workspaceId'), str(p, 'idOrName'));
      broadcastRegistry.broadcast('tui.invalidate', {});
      return { ok: true };
    },

    'session.start': (p) => start(p),

    // What landing the session would bring in, for the cockpit's Changes pane. Local
    // clients only (not in the gateway allowlist): it is the repository's content.
    'session.diff': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      if (row.branch === null) {
        throw new CrossweaveError('DIFF_UNAVAILABLE', `${row.name} works in the shared checkout; it has no branch of its own to diff.`);
      }
      return sessionDiff(projectRoot, row.branch, row.worktreePath);
    },

    'settings.get': () => loadSettings(),
    // Local clients only: it is the user's own file, never in the gateway's allowlist.
    'settings.set': (p) => {
      const next = p.settings as UserSettings | undefined;
      if (typeof next !== 'object' || next === null) {
        throw new CrossweaveError('INVALID_SETTINGS', 'settings must be an object');
      }
      saveSettings(next);
      broadcastRegistry.broadcast('tui.invalidate', {});
      return loadSettings();
    },

    // The in-app editor: files in ONE session's worktree, contained to it (see
    // domain/worktree-files.ts). Local clients only — never in the gateway allowlist.
    'file.list': (p) => listWorktreeFiles(sessionWorktree(p)),
    'file.read': (p) => readWorktreeFile(sessionWorktree(p), str(p, 'path')),
    'file.write': (p) => writeWorktreeFile(
      sessionWorktree(p), str(p, 'path'), str(p, 'content'), optionalNum(p, 'expectedMtimeMs'),
    ),
    // Branches a new session can start from.
    'git.branches': () => new Promise<string[]>((resolve) => {
      execFile('git', ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads/'],
        { cwd: projectRoot, encoding: 'utf8' },
        // cw/integration and cw/trial are crossweave's own scratch branches, reset on
        // every trial — nothing a session should start from.
        (err, stdout) => resolve(err ? [] : String(stdout).split('\n')
          .filter((b) => b !== '' && b !== 'cw/integration' && b !== 'cw/trial')));
    }),

    'terminal.open': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      if (row.worktreePath === null || !existsSync(row.worktreePath)) {
        throw new CrossweaveError('SESSION_NO_WORKDIR', `Session has no working directory: ${row.name}`);
      }
      return terminals.open(row);
    },
    'terminal.list': (p) => terminals.list(str(p, 'workspaceId')),
    'terminal.attach': (p, ctx) => terminals.subscribe(str(p, 'terminalId'), ctx),
    'terminal.input': (p) => {
      terminals.write(str(p, 'terminalId'), str(p, 'data'));
      return { ok: true };
    },
    'terminal.resize': (p) => {
      terminals.resize(str(p, 'terminalId'), num(p, 'cols'), num(p, 'rows'));
      return { ok: true };
    },
    'terminal.close': async (p) => {
      await terminals.close(str(p, 'terminalId'));
      return { ok: true };
    },

    'session.resume': async (p) => {
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
      leaseManager.release(row.id);
      broadcastRegistry.broadcast('tui.invalidate', {});
      return { ok: true };
    },

    'converge.status': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const trials = new MergeTrialRepo(db).listByWorkspace(workspaceId);
      const active = sessions
        .list(workspaceId)
        .filter((s) => s.agentKind !== 'integration' && (s.status === 'running' || s.status === 'idle') && s.branch !== null);

      const graph = buildConflictGraph(trials);
      const order = recommendOrder(active, graph);
      // Both the matrix and the full-integration lookup below key off the
      // RECORDED trial kind, never the branch count: a full-integration trial
      // over exactly 2 active sessions carries 2 branches, so `> 2` found no
      // full-integration row at all in that case while `=== 2` let it stand in
      // as the pair's latest pairwise result.
      const pairwise: { a: string; b: string; result: string }[] = [];
      const seen = new Set<string>();
      // Only pairs of sessions that still exist: trial history outlives its
      // sessions, and listing all of it kept showing a landed-and-removed pair's
      // old conflict as if it were current.
      const activeBranches = new Set(active.map((s) => s.branch as string));
      for (const trial of [...trials].reverse()) {
        if (!isPairwiseTrial(trial) || trial.branches.length !== 2) continue;
        if (!trial.branches.every((b) => activeBranches.has(b))) continue;
        const key = [...trial.branches].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        pairwise.push({ a: trial.branches[0] as string, b: trial.branches[1] as string, result: trial.result });
      }
      const fullIntegration = [...trials].reverse().find((t) => !isPairwiseTrial(t)) ?? null;
      const degraded = active.length > config.converge.pairwiseSessionThreshold;
      // Wrapped like the scheduler's own `baseHead()`: this is a read of the
      // user's repository, which can fail for ordinary reasons (an unborn HEAD
      // in a fresh repo, a git binary problem) that must not surface as an
      // INTERNAL error out of a plain status query. Without the base HEAD no
      // trial's freshness can be judged, so every session degrades to `unknown`
      // — a reportable state — rather than the whole command failing.
      const currentBaseHead = readBaseHead(projectRoot);
      const testCommand = config.converge.testCommand;
      const trust = configTrust.get(workspaceId);
      const hasTrustedTestCommand =
        testCommand !== undefined
        && trust?.testCommandHash === hashTestCommand(testCommand);
      const landability = classifyLandability({
        sessions: order.map((session) => ({ name: session.name, branch: session.branch as string })),
        trials,
        currentBaseHead,
        degraded,
        hasTrustedTestCommand,
        latestFullIntegration: fullIntegration,
      });
      // Pairwise trials merge each pair onto the base, so a conflict with the base
      // shows up there — except for a session with no peer, which has no trial at
      // all and was reported `ready` even right after its land had just failed with
      // LAND_CONFLICT. Every `ready` verdict is checked against the base directly
      // (merge-tree: no worktree, no lock, nothing stored to go stale). If git
      // cannot tell, the verdict stands as before.
      if (currentBaseHead !== null) {
        for (const name of landability.ready) {
          const branch = order.find((s) => s.name === name)?.branch;
          if (branch === null || branch === undefined) continue;
          const files = baseConflictFiles(projectRoot, currentBaseHead, branch);
          if (files !== undefined && files.length > 0) {
            landability.byName.set(name, {
              name, landability: 'blocked', reason: `conflicts with the current base: ${files.join(', ')}`,
            });
          }
        }
      }
      const unknown = [...landability.byName.values()]
        .filter((result) => result.landability === 'unknown')
        .map(({ name, reason }) => ({ name, reason }));
      const blocked = [...landability.byName.values()]
        .filter((result) => result.landability === 'blocked')
        .map(({ name, reason }) => ({ name, reason }));
      // Nothing to land is its own answer, not "ready": landing an empty branch is a
      // no-op, and a green badge on a session that has done nothing is a false signal.
      const empty: string[] = [];
      if (currentBaseHead !== null) {
        for (const session of order) {
          if (commitsAhead(projectRoot, currentBaseHead, session.branch as string) === 0) empty.push(session.name);
        }
      }
      const ready = landability.ready
        .filter((name) => landability.byName.get(name)?.landability === 'ready' && !empty.includes(name));

      return {
        pairwise,
        fullIntegration: fullIntegration
          ? {
              result: fullIntegration.result,
              ts: fullIntegration.ts,
              detail: fullIntegration.detail,
              baseHead: fullIntegration.baseHead,
            }
          : null,
        recommendedOrder: order.map((s) => s.name),
        conflictFree: ready,
        ready,
        unknown,
        blocked,
        empty,
        degraded,
        baseBranch: readBaseBranch(projectRoot),
      };
    },

    'land.session': async (p) => {
      const workspaceId = str(p, 'workspaceId');
      const target = sessions.resolve(workspaceId, str(p, 'idOrName'));
      // Landing removes the worktree the session's shells are sitting in.
      await terminals.closeForSession(target.id);
      const force = bool(p, 'force', false);
      // `landSession` only has raw `SessionRepo` access and cannot reach the running
      // agent process — stopping it here, before landing, is what makes `--force`
      // actually stop a live session rather than just release its leases out from
      // under it. `removeWorktree: false` leaves the worktree/branch intact for
      // `landSession` to land normally; the row becomes `dead`, so `landSession`'s
      // own `status === 'running'` refusal no longer applies, which is correct for a
      // forced land.
      if (force && target.status === 'running') {
        await sessions.kill(workspaceId, target.id, { removeWorktree: false });
      }
      // notify() failing/throwing is already caught inside notify() itself (design
      // doc §3.5) — the try/catch here exists ONLY to observe landSession's own
      // outcome for the notification's content, and re-throws unconditionally so the
      // caller's real result/error is never altered by this wiring.
      try {
        const result = await landSession(
          { db, projectRoot, sessions: sessionsRepo, leaseManager, ledger, config, configTrust },
          workspaceId, target.id, { force },
        );
        const event = { kind: 'land' as const, session: target.name, ok: true as const, baseBranch: result.baseBranch, workspaceId };
        notify(notifyDeps, event);
        broadcastRegistry.broadcast('tui.event', event);
        broadcastRegistry.broadcast('tui.invalidate', {});
        return result;
      } catch (err) {
        const reason = err instanceof CrossweaveError ? err.code : String(err);
        const event = { kind: 'land' as const, session: target.name, ok: false as const, reason, workspaceId };
        notify(notifyDeps, event);
        broadcastRegistry.broadcast('tui.event', event);
        throw err;
      }
    },

    'config.trust': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const testCommand = config.converge.testCommand;
      if (testCommand === undefined) {
        throw new CrossweaveError('CONFIG_NO_TEST_COMMAND', 'converge.testCommand is not set; nothing to trust.');
      }
      configTrust.upsert({ workspaceId, testCommandHash: hashTestCommand(testCommand), trustedAt: new Date().toISOString() });
      return { trusted: true, testCommand };
    },

    'config.status': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const testCommand = config.converge.testCommand;
      const trusted = testCommand !== undefined && isTestCommandTrusted(testCommand, configTrust, workspaceId);
      const n = notifyConfig.get(workspaceId);
      // Explicit field list rather than spreading `n` directly, so the shape is
      // identical whether or not a row exists yet — `n` also carries `workspaceId`,
      // which the CLI/client side has no use for and shouldn't have to ignore.
      return {
        testCommand: testCommand ?? null,
        trusted,
        notify: {
          enabled: n?.enabled ?? true,
          land: n?.land ?? true,
          convergence: n?.convergence ?? true,
        },
      };
    },

    'config.setNotify': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const event = optionalEventKind(p, 'event');
      const enabled = bool(p, 'enabled', true);
      if (event === undefined) {
        notifyConfig.setEnabled(workspaceId, enabled);
      } else {
        notifyConfig.setEvent(workspaceId, event, enabled);
      }
      return notifyConfig.get(workspaceId) ?? { workspaceId, enabled: true, land: true, convergence: true };
    },

    'config.untrust': (p) => {
      configTrust.clear(str(p, 'workspaceId'));
      return { trusted: false };
    },

    // Horizon B's journal: what a client had open, so a restart can put it back. The
    // daemon owns the file because it owns `.crossweave/` — a renderer writing it directly
    // would break the one-writer rule AND could not work over the gateway, where the
    // client has no local filesystem. See src/domain/journal.ts.
    'journal.get': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const entry = readJournal(projectRoot);
      // A mismatched workspaceId reads as empty: a journal left over from a deleted
      // workspace must not restore panes into the one that replaced it.
      return entry && entry.workspaceId === workspaceId ? entry : emptyJournal(workspaceId);
    },

    // `openTabs` is client-supplied, so it is validated like any other external input:
    // `sessions.list` already excludes the integration session (infrastructure the user
    // cannot address, so never a pane) and this workspace's other sessions do not exist
    // in it. normalizeTabs then dedupes and caps. fileSurfaces is written empty and
    // always: there is no file-surface feature to journal yet, and a client-supplied
    // path list would be state the daemon could not vouch for.
    'journal.set': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const known = new Set(sessions.list(workspaceId).map((s) => s.id));
      const openTabs = normalizeTabs(p.openTabs, (id) => known.has(id));
      writeJournal(projectRoot, {
        workspaceId,
        openTabs,
        fileSurfaces: [],
        at: new Date().toISOString(),
      });
      return { openTabs };
    },

    // The TUI's live feed: no params, subscribes this connection to every future
    // `tui.event`/`tui.invalidate` broadcast until it closes (see
    // src/daemon/broadcast.ts's own doc comment for the two message kinds).
    'daemon.subscribe': (_p, ctx) => {
      const unsubscribe = broadcastRegistry.subscribe(ctx.notify.bind(ctx));
      ctx.onClose(unsubscribe);
      return { subscribed: true };
    },

    'daemon.shutdown': async () => {
      convergenceScheduler.stop();
      await terminals.closeAll();
      await runtime.stopAll();
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },
  };
}
