import type { Database } from 'bun:sqlite';
import { execFile, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager } from '../domain/workspace.js';
import { SessionManager, type AdapterFactory } from '../domain/session.js';
import { CrossweaveError } from '../core/errors.js';
import { daemonLog } from '../core/log.js';
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
import { SessionSetupRepo } from '../db/repositories/session-setup.js';
import { decideSetup, runTeardown, SETUP_UNTRUSTED_NOTICE, withSetup } from '../domain/session-setup.js';
import { NotifyConfigRepo, type NotifyEventKind } from '../db/repositories/notify-config.js';
import { buildConflictGraph, recommendOrder } from '../convergence/graph.js';
import { classifyLandability } from '../convergence/evidence.js';
import { landSession } from '../convergence/land.js';
import { hashHooks, hashTestCommand, isHooksTrusted, isTestCommandTrusted } from '../convergence/trust.js';
import { emptyJournal, normalizeTabs, readJournal, writeJournal } from '../domain/journal.js';
import { overlapPairs, type SessionPaths } from '../domain/overlap.js';

import { NotificationGate } from '../notify/gate.js';
import { notify, type NotifyDispatcherDeps } from '../notify/dispatcher.js';
import { platformSend } from '../notify/macos.js';
import { BroadcastRegistry } from './broadcast.js';
import { measureWorktrees } from '../isolation/disk-guard.js';
import { LeaseRepo } from '../db/repositories/lease.js';
import { spawnShell } from '../adapters/shell.js';
import { latestWords } from '../domain/agent-logs.js';
import { listFolderFiles, listWorktreeFiles, readWorktreeFile, writeWorktreeFile } from '../domain/worktree-files.js';
import { BUILTIN_LAUNCHERS, loadSettings, saveSettings, type LauncherDef, type UserSettings } from '../core/settings.js';
import { TerminalRegistry } from './terminals.js';
import { ActivityTracker, detectAgents } from './session-status.js';
import { GitCounter } from './git-counts.js';
import { RepoScanner } from './repo-scan.js';
import { OverlapTracker } from './overlap.js';
import { UsageReader, UsageTracker } from '../domain/agent-usage.js';
import { launcherProgram } from '../core/launcher-program.js';
import { loginShellPath, mergePaths } from '../core/login-path.js';
import { loginShellNames } from '../core/shell-names.js';

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
    /**
     * False for a plain folder (no git; the cockpit's "Open as a plain folder"): sessions
     * run in the folder itself, and branches, worktrees, git counts, diff, land and
     * convergence are off.
     */
    git?: boolean;
    // Injected so tests can assert on notification call counts without spawning a
    // real terminal-notifier/osascript process — defaults to the real platform send.
    notifySend?: (title: string, message: string, clickCommand: string[] | undefined) => void;
    /** The Terminal pane's shell; defaults to $SHELL. Injected so tests run /bin/sh. */
    shell?: string;
    /** The status tracker's clock, injected so tests never wait on real time. */
    now?: () => number;
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
  const sessionSetup = new SessionSetupRepo(db);
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
  const hasGit = opts.git !== false;
  // Convergence trials merge branches: a plain folder has none.
  if (opts.startBackgroundJobs === true && hasGit) convergenceScheduler.start();

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

  const userHome = (): string => process.env.HOME || homedir();
  // What each session is doing (working / asked / idle / failed) and which agent runs
  // in it, inferred from its shell — see src/daemon/session-status.ts.
  const activity = new ActivityTracker(opts.now);
  const agents = new Map<string, string | null>();
  const runtime = new SessionRuntime((sessionId) => {
    sessions.clearRunning(sessionId);
    leaseManager.release(sessionId);
    // A shell that exits on its own (`exit`, a crash) is a status change no RPC
    // announced; every client kept showing it `running` until something else redrew.
    broadcastRegistry.broadcast('tui.invalidate', {});
  }, activity);
  sessions.onKill = (id) => runtime.stop(id);

  /**
   * One sweep: which agent runs under each shell (a single `ps` for all of them), then
   * whose activity changed. Clients redraw on a change only — a session that keeps
   * working keeps its state and costs no broadcast.
   */
  const STATUS_SWEEP_MS = 1500;
  // One scan per folder feeds both counters (see RepoScanner): the overlap signal must
  // not cost a second `git status` the git badge already ran.
  const scanner = new RepoScanner();
  const gitCounts = new GitCounter((folder, baseHead) => scanner.counts(folder, baseHead));
  const overlap = new OverlapTracker((folder, baseHead) => scanner.scan(folder, baseHead));
  const usage = new UsageTracker(new UsageReader(userHome()));
  let sweeping = false;
  async function sweepStatus(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      const pids = runtime.pids();
      let agentsChanged = false;
      if (pids.size > 0) {
        const ps = await new Promise<string>((resolve) => {
          execFile('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
            (err, stdout) => resolve(err ? '' : String(stdout)));
        });
        for (const [id, agent] of detectAgents(ps, pids)) {
          if (agents.get(id) !== agent) {
            agents.set(id, agent);
            agentsChanged = true;
          }
        }
      }
      for (const id of [...agents.keys()]) if (!pids.has(id)) agents.delete(id);
      const changed = activity.sweep((id) => agents.get(id) ?? null);
      if (agentsChanged || changed.length > 0) broadcastRegistry.broadcast('tui.invalidate', {});
    } finally {
      sweeping = false;
    }
  }
  const statusTimer = opts.startBackgroundJobs === true
    ? setInterval(() => { void sweepStatus(); }, STATUS_SWEEP_MS)
    : undefined;

  // Extra shells in a session's worktree (split panes), beside the session's own.
  const terminals = new TerminalRegistry((row) => spawnShell({
    shell: opts.shell ?? process.env.SHELL ?? '/bin/sh',
    cwd: row.worktreePath as string,
    env: { CW_SESSION_ID: row.id, CW_SESSION_NAME: row.name },
  }), () => broadcastRegistry.broadcast('tui.invalidate', {}));

  /** The worktree of the session a file RPC names; it must still be on disk. */
  function sessionWorktree(p: Record<string, unknown>): string {
    const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
    if (row.worktreePath === null || !existsSync(row.worktreePath)) {
      throw new CrossweaveError('SESSION_NO_WORKDIR', `Session has no working directory: ${row.name}`);
    }
    return row.worktreePath;
  }

  /**
   * `hooks.sessionTeardown`, run best effort in the session's own worktree just before
   * that worktree is removed. Unlike `sessionSetup` there is no shell left to type into
   * at this point, so the daemon spawns it. Untrusted hooks are skipped with a warning
   * rather than run, and a failure is a warning — the removal must never be blocked.
   */
  async function teardownFor(row: SessionRow): Promise<string[]> {
    const hooks = config.hooks;
    const command = hooks?.sessionTeardown;
    if (command === undefined) return [];
    if (row.worktreePath === null || row.worktreePath === projectRoot || !existsSync(row.worktreePath)) return [];
    if (!isHooksTrusted(hooks ?? {}, configTrust, row.workspaceId)) {
      return [`hooks.sessionTeardown is not trusted; skipped for ${row.name}`];
    }
    const warning = await runTeardown(command, row.worktreePath, {});
    return warning === undefined ? [] : [warning];
  }

  /**
   * The sessions the overlap signal covers: worktree sessions, not the shared checkout
   * (no branch of its own) and not a plain folder (no git), and not finished ones.
   */
  function overlapTargets(listed: SessionRow[]): Array<{ id: string; name: string; folder: string; baseHead: string | null }> {
    const baseHead = readBaseHead(projectRoot);
    const targets: Array<{ id: string; name: string; folder: string; baseHead: string | null }> = [];
    for (const session of listed) {
      const folder = session.worktreePath;
      if (folder === null || folder === projectRoot) continue;
      if (session.status === 'landed' || !existsSync(folder)) continue;
      targets.push({ id: session.id, name: session.name, folder, baseHead });
    }
    return targets;
  }

  /**
   * Overlap pairs computed NOW, not from the rail's background tracker: a one-shot CLI
   * answer must be fresh, and the tracker only catches up on the next `session.list`
   * redraw. Read-only; the scans are the ones the shared `RepoScanner` already caches.
   */
  async function computeOverlapPairs(listed: SessionRow[]): Promise<Array<{ a: string; b: string; paths: string[] }>> {
    const paths: SessionPaths[] = [];
    for (const target of overlapTargets(listed)) {
      const scan = await scanner.scan(target.folder, target.baseHead);
      if (scan === null) continue;
      paths.push({ name: target.name, paths: [...scan.changedPaths, ...scan.committedPaths] });
    }
    const pairs: Array<{ a: string; b: string; paths: string[] }> = [];
    const seen = new Set<string>();
    for (const [name, overlaps] of overlapPairs(paths)) {
      for (const other of overlaps) {
        const a = name < other.session ? name : other.session;
        const b = name < other.session ? other.session : name;
        const key = `${a}|${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ a, b, paths: other.paths });
      }
    }
    return pairs;
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

  /** The saved launcher a start names (`launcher: 'claude'`), if any. */
  function launcherFor(p: Record<string, unknown>): LauncherDef | undefined {
    const id = optionalStr(p, 'launcher');
    if (id === undefined || id === 'terminal') return undefined;
    const found = loadSettings().launchers.find((l) => l.id === id);
    if (found === undefined) throw new CrossweaveError('UNKNOWN_LAUNCHER', `No launcher named ${id} — see Settings`);
    if (!found.enabled) throw new CrossweaveError('LAUNCHER_DISABLED', `${found.label} is turned off in Settings`);
    return found;
  }

  /**
   * A launcher's line, typed into the shell once it is open. One line only: a line
   * break would make the shell run a second command nobody chose.
   */
  function runLine(p: Record<string, unknown>): string | undefined {
    const launcher = launcherFor(p);
    if (launcher !== undefined) return launcher.command;
    const run = p.run;
    if (run === undefined) return undefined;
    if (typeof run !== 'string' || run.trim() === '' || run.length > 2000 || /[\r\n\0]/.test(run)) {
      throw new CrossweaveError('INVALID_PARAMS', 'run must be one line of at most 2000 characters');
    }
    return run;
  }

  async function start(p: Record<string, unknown>): Promise<SessionRow> {
    const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
    assertResumable(row);
    const run = runLine(p);
    // Synchronous check-and-mark, before the first `await` below: see the comment
    // on `starting` above for why this closes the concurrent-start race.
    if (starting.has(row.id)) {
      throw new CrossweaveError('SESSION_ALREADY_RUNNING', `Session already starting: ${row.name}`);
    }
    starting.add(row.id);
    try {
      // A lease must win over the client's shell, or a session's port would depend
      // on what the user happened to export.
      // The launcher's env over the client's, and the lease over both: a session's port
      // must not depend on what a launcher or the user's terminal happened to export.
      const env: Record<string, string> = {
        ...clientEnv(p),
        ...(launcherFor(p)?.env ?? {}),
        ...(await leaseManager.acquire(row.id)),
      };
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
      // Typed, not exec'd: the shell reads it once its rc files have run, and when the
      // agent exits the user is back at a prompt in the worktree. The setup hook rides
      // the same path — typed once, at this session's first start, ahead of the launcher
      // and `&&`-chained with it so a failed setup does not start an agent on a
      // half-installed tree. Its output lands in the very pty the user is looking at.
      const hasWorktree = row.worktreePath !== null && row.worktreePath !== projectRoot && existsSync(row.worktreePath);
      const setup = decideSetup({
        hooks: config.hooks,
        trusted: config.hooks !== undefined && isHooksTrusted(config.hooks, configTrust, row.workspaceId),
        alreadyRan: sessionSetup.has(row.id),
        hasWorktree,
      });
      if (setup.command !== undefined) {
        sessionSetup.mark(row.id);
        runtime.write(row.id, row.name, `${withSetup(setup.command, run)}\r`);
      } else {
        if (setup.skipped === 'untrusted') runtime.write(row.id, row.name, `${SETUP_UNTRUSTED_NOTICE}\r`);
        if (run !== undefined) runtime.write(row.id, row.name, `${run}\r`);
      }
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

    'workspace.init': (p) => ({ ...workspaces.init(projectRoot, optionalStr(p, 'name')), git: hasGit }),
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
      // `onBeforeRemove` is where `hooks.sessionTeardown` runs: gc owns the removal, so it
      // is the only place that knows which worktrees are actually about to go.
      const result = await collectGarbage(db, id, {
        force: bool(p, 'force', false),
        onBeforeRemove: (session) => teardownFor(session),
      });
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
        // A plain folder has no worktrees to make: its sessions run in the folder.
        worktree: hasGit ? bool(p, 'worktree', true) : false,
        budgetTokens: optionalNum(p, 'budgetTokens'),
        budgetUsd: optionalNum(p, 'budgetUsd'),
        base: optionalStr(p, 'base'),
      });
      broadcastRegistry.broadcast('tui.invalidate', {});
      return row;
    },
    'session.list': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const listed = sessions.list(workspaceId);
      // Per-workspace, so read once rather than per row: a worktree session that has not
      // had its (trusted) setup hook typed yet carries `setup: 'pending'` to the rail.
      const hooksForList = config.hooks;
      const hooksTrusted = hooksForList?.sessionSetup !== undefined && isHooksTrusted(hooksForList, configTrust, workspaceId);
      // Read once for the whole list, not once per row: this runs on every redraw.
      const setupRan = hooksTrusted ? sessionSetup.markedIds() : undefined;
      // Read in the background; a change is announced like any other, and the next
      // list carries it.
      if (hasGit) void gitCounts.refresh(() => {
        const baseHead = readBaseHead(projectRoot);
        return listed
          .filter((s) => s.worktreePath !== null && s.status !== 'landed' && existsSync(s.worktreePath))
          .map((s) => ({ id: s.id, folder: s.worktreePath as string, baseHead: s.worktreePath === projectRoot ? null : baseHead }));
      }).then((changed) => {
        if (changed) broadcastRegistry.broadcast('tui.invalidate', {});
      });
      // The overlap signal reads the SAME scan (through the shared RepoScanner), so it
      // costs no extra git. Only worktree sessions take part: a shared session has no
      // branch to overlap on, and a plain folder has no git at all.
      if (hasGit) void overlap.refresh(() => overlapTargets(listed)).then((changed) => {
        if (changed) broadcastRegistry.broadcast('tui.invalidate', {});
      });
      // Tokens the agents run in each session's own worktree have used since it was
      // created. Not for a session in the project folder: every Claude run there —
      // one in a terminal outside crossweave too — writes to the same log folder, and
      // nothing in the logs says which shell ran it. Crediting the folder's logs to such
      // a session showed 326M tokens on one nobody had used.
      void usage.refresh(() => listed
        .filter((s) => s.worktreePath !== null && s.worktreePath !== projectRoot && s.status !== 'landed')
        .map((s) => ({ id: s.id, cwd: s.worktreePath as string, since: Date.parse(s.createdAt) || 0 })))
        .then((changed) => {
          if (changed) broadcastRegistry.broadcast('tui.invalidate', {});
        });
      return listed.map((session) => {
        // Whatever the user ran in this worktree last said, read from its own log
        // (Claude Code, Codex), found by the worktree path, not by what launched it.
        const words = session.worktreePath !== null && session.worktreePath !== projectRoot
          ? latestWords({ home: userHome(), cwd: session.worktreePath })
          : undefined;
        const agent = agents.get(session.id) ?? null;
        const status = activity.status(session.id, agent);
        const git = gitCounts.get(session.id);
        const overlaps = overlap.get(session.id);
        const setupPending = setupRan !== undefined
          && session.worktreePath !== null && session.worktreePath !== projectRoot
          && !setupRan.has(session.id);
        const used = session.worktreePath === projectRoot ? undefined : usage.get(session.id);
        const size = runtime.size(session.id);
        const withWords = {
          ...session,
          ...(used === undefined ? {} : { usage: used }),
          ...(words === undefined ? {} : { latestWords: words }),
          ...(git === undefined ? {} : { git }),
          ...(overlaps === undefined ? {} : { overlaps }),
          ...(setupPending ? { setup: 'pending' as const } : {}),
          ...(size === undefined ? {} : size),
          agent,
          activity: status.activity,
          lastActivityAt: status.lastActivityAt,
          rang: status.rang,
        };
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
      });
    },
    'session.note': (p) => {
      const row = sessions.setNote(str(p, 'workspaceId'), str(p, 'idOrName'), str(p, 'note'));
      broadcastRegistry.broadcast('tui.invalidate', {});
      return row;
    },
    'session.rename': (p) =>
      sessions.rename(str(p, 'workspaceId'), str(p, 'idOrName'), str(p, 'newName')),
    'session.kill': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      const removeWorktree = bool(p, 'removeWorktree', false);
      // Killing keeps the worktree (it can still be landed), and a shell there is
      // still useful; only a kill that deletes it takes the shells first.
      if (removeWorktree) await terminals.closeForSession(row.id);
      const warnings = await sessions.kill(str(p, 'workspaceId'), str(p, 'idOrName'), {
        removeWorktree,
        onBeforeRemove: (r) => teardownFor(r),
      });
      broadcastRegistry.broadcast('tui.invalidate', {});
      return { ok: true, warnings };
    },
    'session.rm': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      await terminals.closeForSession(row.id);
      // Teardown is run by `remove`, AFTER its liveness refusal: a live session's
      // `rm` must be refused without a teardown's side effects (see SessionManager.remove).
      const warnings = await sessions.remove(str(p, 'workspaceId'), str(p, 'idOrName'), {
        onBeforeRemove: (r) => teardownFor(r),
      });
      sessionSetup.clear(row.id);
      broadcastRegistry.broadcast('tui.invalidate', {});
      return { ok: true, warnings };
    },

    // Run `hooks.sessionSetup` again by hand. With the hook typed into the shell, that
    // means: clear the once-marker so the next start types it — and, when the shell is
    // already open, type it into that shell right now.
    'session.setup': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      const hooks = config.hooks;
      const command = hooks?.sessionSetup;
      if (command === undefined) {
        throw new CrossweaveError('CONFIG_NO_HOOKS', 'hooks.sessionSetup is not set in crossweave.config.json.');
      }
      if (!isHooksTrusted(hooks ?? {}, configTrust, row.workspaceId)) {
        throw new CrossweaveError('HOOKS_UNTRUSTED', 'hooks.sessionSetup is not trusted for this workspace. Review crossweave.config.json, then run `cw config trust hooks`.');
      }
      if (row.worktreePath === null || row.worktreePath === projectRoot || !existsSync(row.worktreePath)) {
        throw new CrossweaveError('SESSION_NO_WORKDIR', `Session has no worktree of its own to set up: ${row.name}`);
      }
      sessionSetup.clear(row.id);
      const typed = runtime.isRunning(row.id);
      if (typed) {
        runtime.write(row.id, row.name, `${command}\r`);
        sessionSetup.mark(row.id);
      }
      broadcastRegistry.broadcast('tui.invalidate', {});
      return { typed };
    },

    'session.start': (p) => start(p),

    // What landing the session would bring in, for the cockpit's Changes pane. Local
    // clients only (never to be offered remotely): it is the repository's content.
    'session.diff': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      if (row.branch === null) {
        throw new CrossweaveError('DIFF_UNAVAILABLE', `${row.name} works in the shared checkout; it has no branch of its own to diff.`);
      }
      return sessionDiff(projectRoot, row.branch, row.worktreePath);
    },

    // The launchers a new session can start with, and whether this machine has each
    // one's program — looked up on the user's login-shell PATH, which is what the
    // session's shell will have (a cockpit opened from the Dock has launchd's minimal
    // PATH, where ~/.local/bin does not exist).
    'launchers.list': async () => {
      const [loginPath, shellNames] = await Promise.all([loginShellPath(), loginShellNames()]);
      const PATH = mergePaths(process.env.PATH, loginPath) ?? '';
      return loadSettings().launchers.map((l) => {
        const program = launcherProgram(l.command);
        // On PATH, or an alias/function the user's shell defines (a `cx` wrapper):
        // the line is typed into that shell, so either runs.
        const available = program !== undefined && (Bun.which(program, { PATH }) !== null || shellNames.has(program));
        // A built-in's shipped form, for the Settings form's Reset.
        const shipped = BUILTIN_LAUNCHERS.find((b) => b.id === l.id);
        return { ...l, available, ...(shipped ? { defaults: { label: shipped.label, command: shipped.command } } : {}) };
      });
    },
    'settings.get': () => loadSettings(),
    // Local clients only: it is the user's own file, never to be offered remotely.
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
    // domain/worktree-files.ts). Local clients only — never to be offered remotely.
    'file.list': (p) => (hasGit ? listWorktreeFiles(sessionWorktree(p)) : listFolderFiles(sessionWorktree(p))),
    'file.read': (p) => readWorktreeFile(sessionWorktree(p), str(p, 'path')),
    'file.write': (p) => writeWorktreeFile(
      sessionWorktree(p), str(p, 'path'), str(p, 'content'), optionalNum(p, 'expectedMtimeMs'),
    ),
    // Branches a new session can start from.
    'git.branches': () => (!hasGit ? Promise.resolve([] as string[]) : new Promise<string[]>((resolve) => {
      execFile('git', ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads/'],
        { cwd: projectRoot, encoding: 'utf8' },
        // cw/integration and cw/trial are crossweave's own scratch branches, reset on
        // every trial — nothing a session should start from.
        (err, stdout) => resolve(err ? [] : String(stdout).split('\n')
          .filter((b) => b !== '' && b !== 'cw/integration' && b !== 'cw/trial')));
    })),

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
      runLine(p);
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

    // The overlap signal on demand, for the CLI's one-shot `cw overlap`. The rail reads
    // it from `session.list` (which must not block on git); a CLI answer must be fresh.
    'overlap.list': async (p) => {
      const workspaceId = str(p, 'workspaceId');
      return { pairs: await computeOverlapPairs(sessions.list(workspaceId)) };
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
          {
            db, projectRoot, sessions: sessionsRepo, leaseManager, ledger, config, configTrust,
            // Landing removes the worktree too, so its teardown must run as well —
            // not only `session rm`/`gc`, or `docker compose down` never fires on the
            // most common way a session ends.
            onBeforeRemoveWorktree: (r) => teardownFor(r),
          },
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

    // Two separate trusts, deliberately (see src/convergence/trust.ts): the test command
    // runs only on an explicit `cw land --yes`, the hooks run automatically on a
    // session's first start, so trusting one must never arm the other. `target` picks.
    'config.trust': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const target = optionalStr(p, 'target') ?? 'testCommand';
      if (target === 'hooks') {
        const hooks = config.hooks;
        if (hooks === undefined || (hooks.sessionSetup === undefined && hooks.sessionTeardown === undefined)) {
          throw new CrossweaveError('CONFIG_NO_HOOKS', 'hooks are not set in crossweave.config.json; nothing to trust.');
        }
        configTrust.setHooks(workspaceId, hashHooks(hooks), new Date().toISOString());
        return { trusted: true, target: 'hooks' };
      }
      if (target !== 'testCommand') {
        throw new CrossweaveError('INVALID_PARAMS', `Unknown trust target: ${target} (expected testCommand or hooks)`);
      }
      const testCommand = config.converge.testCommand;
      if (testCommand === undefined) {
        throw new CrossweaveError('CONFIG_NO_TEST_COMMAND', 'converge.testCommand is not set; nothing to trust.');
      }
      configTrust.upsert({ workspaceId, testCommandHash: hashTestCommand(testCommand), trustedAt: new Date().toISOString() });
      return { trusted: true, target: 'testCommand', testCommand };
    },

    'config.status': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const testCommand = config.converge.testCommand;
      const trusted = testCommand !== undefined && isTestCommandTrusted(testCommand, configTrust, workspaceId);
      const hooks = config.hooks;
      const hasHooks = hooks !== undefined && (hooks.sessionSetup !== undefined || hooks.sessionTeardown !== undefined);
      const hooksTrusted = hasHooks && isHooksTrusted(hooks, configTrust, workspaceId);
      const n = notifyConfig.get(workspaceId);
      // Explicit field list rather than spreading `n` directly, so the shape is
      // identical whether or not a row exists yet — `n` also carries `workspaceId`,
      // which the CLI/client side has no use for and shouldn't have to ignore.
      return {
        testCommand: testCommand ?? null,
        trusted,
        hooks: {
          sessionSetup: hooks?.sessionSetup ?? null,
          sessionTeardown: hooks?.sessionTeardown ?? null,
          trusted: hooksTrusted,
        },
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
    // would break the one-writer rule AND could not work for a remote client, which has
    // no local filesystem. See src/domain/journal.ts.
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
      // Says how many shells this takes down, because nothing else does: an explicit
      // `cw daemon stop` and the socket-loss self-shutdown both hang up every session.
      daemonLog(`daemon.shutdown requested — hanging up ${runtime.pids().size} session(s)`);
      convergenceScheduler.stop();
      if (statusTimer !== undefined) clearInterval(statusTimer);
      await terminals.closeAll();
      await runtime.stopAll();
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },
  };
}
