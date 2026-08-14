import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
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
import { MessageBus } from '../domain/bus.js';
import { ContextStore } from '../domain/context-store.js';
import { reconcile } from '../domain/reconciliation.js';
import { createMcpServer, type McpServerHandle } from '../mcp/server.js';
import { buildTools } from '../mcp/tools.js';
import { RadarWatcherRegistry } from './watcher.js';
import { FileClaimRepo } from '../db/repositories/file-claim.js';
import { decideBlocked } from '../radar/decision.js';
import { ContractService, parseFqn } from '../radar/contracts.js';
import { assertContained } from '../core/paths.js';
import { ConvergenceScheduler } from './convergence-scheduler.js';
import { MergeTrialRepo } from '../db/repositories/merge-trial.js';
import { ConfigTrustRepo } from '../db/repositories/config-trust.js';
import { NotifyConfigRepo, type NotifyEventKind } from '../db/repositories/notify-config.js';
import { buildConflictGraph, recommendOrder } from '../convergence/graph.js';
import { landSession } from '../convergence/land.js';
import { hashTestCommand, isTestCommandTrusted } from '../convergence/trust.js';
import { createAdapter } from '../adapters/registry.js';
import type { AcpAdapterDeps } from '../adapters/acp.js';
import { recordUsage } from '../domain/usage.js';

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
  if (v === 'collision' || v === 'blocked' || v === 'land' || v === 'convergence') return v;
  return undefined;
}

/**
 * The daemon inherits the environment of whichever `cw` invocation happened to start
 * it, and by default every agent it spawns would get THAT environment forever —
 * stale toolchain, wrong virtualenv, whatever was exported when the daemon booted.
 * The client forwards its own `process.env` on every start/resume so the agent gets
 * the shell the user actually meant.
 */
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
  opts: { startBackgroundJobs?: boolean } = {},
): Record<string, MethodHandler> {
  const workspaces = new WorkspaceManager(db);
  // Constructed before `sessions` (SessionManager) deliberately: the default
  // adapterFactory closure below needs `sessionsRepo`/`fileClaims` already built —
  // both are cheap, stateless wrappers around `db`, so building them slightly earlier
  // than their other uses later in this function costs nothing.
  const sessionsRepo = new SessionRepo(db);
  const fileClaims = new FileClaimRepo(db);
  const cursorDeps: AcpAdapterDeps = {
    resolveWorkspaceId: (sessionId) => {
      const row = sessionsRepo.findById(sessionId);
      if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
      return row.workspaceId;
    },
    decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
    recordUsage: (params) => recordUsage({ sessions: sessionsRepo }, params),
  };
  // A caller-supplied adapterFactory (every existing test) is used AS-IS, unwrapped —
  // it's a full override, not something this daemon's cursor deps should be spliced
  // into. Only the real, no-override daemon path gets the deps-injected default.
  const sessions = new SessionManager(db, adapterFactory ?? ((kind) => createAdapter(kind, cursorDeps)), config);
  const leaseManager = new LeaseManager(db, projectRoot, config);
  // Nothing a previous daemon held can have survived its death, and a lease left
  // marked active would permanently shrink the pool.
  leaseManager.releaseAll();

  const ledger = new EventLedger(db, projectRoot);
  const bus = new MessageBus(db, sessions);
  const contextStore = new ContextStore(db);
  const contracts = new ContractService(db);
  const radarWatchers = new RadarWatcherRegistry(db, bus, contracts);
  const configTrust = new ConfigTrustRepo(db);
  const notifyConfig = new NotifyConfigRepo(db);
  const convergenceScheduler = new ConvergenceScheduler(db, projectRoot, config, leaseManager, configTrust);
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

  /** The server that is a session's CURRENT one. Never holds a closing server. */
  const mcpServers = new Map<string, McpServerHandle>();
  /**
   * Closes still in flight, tracked separately from `mcpServers` on purpose.
   *
   * Deleting the map entry only once `close()` resolves conflates two questions: a
   * `session.start` for the same id landing during a close (a fast stop-then-resume;
   * the daemon dispatches socket messages unserialized) would then have its brand-new
   * server deleted by the old close's cleanup — running, unreachable and untracked,
   * so neither `session.stop` nor `daemon.shutdown` would ever close it. The map
   * therefore loses its entry synchronously, and `daemon.shutdown` awaits genuinely
   * in-flight closes through this set instead.
   */
  const closingMcpServers = new Set<Promise<void>>();

  /**
   * Retires `handle` as `sessionId`'s server. The map entry is dropped ONLY if it
   * still points at this exact handle — never at "whatever is currently registered
   * for this id", which may already be a newer server.
   */
  function closeMcpServer(sessionId: string, handle: McpServerHandle): Promise<void> {
    if (mcpServers.get(sessionId) === handle) mcpServers.delete(sessionId);
    const pending: Promise<void> = handle.close().catch(() => undefined);
    closingMcpServers.add(pending);
    void pending.finally(() => closingMcpServers.delete(pending));
    return pending;
  }

  const runtime = new SessionRuntime((sessionId) => {
    sessions.clearRunning(sessionId);
    leaseManager.release(sessionId);
    radarWatchers.stop(sessionId);
    const handle = mcpServers.get(sessionId);
    if (handle !== undefined) void closeMcpServer(sessionId, handle);
  });
  sessions.onKill = (id) => runtime.stop(id);

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
      const env = { ...clientEnv(p), ...(await leaseManager.acquire(row.id)) };
      const pid = runtime.start(row, sessions.adapterFor(row.agentKind), env);
      sessions.markStatus(row.id, 'running', pid);
      ledger.append({ sessionId: row.id, workspaceId: row.workspaceId, kind: 'session.started', payload: '{}' });

      // Registered synchronously, in the same synchronous region as
      // `runtime.start` above and before this function's next `await` —
      // exactly like `mcpServers.set` below is NOT (it follows an await),
      // which is precisely the gap this block must avoid: a `session.stop`/
      // kill/crash landing before an awaited registration would find nothing
      // to stop, then have the continuation install a watcher for a session
      // that is no longer live. Only sessions with their own worktree have a
      // fork point to diff against — a shared (`--no-worktree`) session is
      // never watched.
      if (row.worktreePath !== null && row.worktreePath !== projectRoot) {
        const forkPoint = ledger.forkPointFor(row.id);
        if (forkPoint !== undefined) {
          radarWatchers.start({
            id: row.id, workspaceId: row.workspaceId,
            worktreePath: row.worktreePath, forkPoint,
          });
        }
      }

      // Best effort: messaging/context tools are a real feature but not the reason
      // the session exists. A socket bind failure here (see mcpSocketPath's own
      // length guard, and main.ts's top-level handler) degrades this one session
      // to "no MCP tools available" rather than failing the whole start. Awaiting
      // `ready()` (not just calling `createMcpServer` synchronously) is what makes
      // `session.mcpInfo`'s `listening()` check deterministic the moment this RPC
      // returns, instead of racing an in-flight async bind.
      try {
        // A server still registered for this id has been superseded — retire it
        // explicitly rather than dropping the reference, or it would keep running
        // with nothing left able to close it.
        const superseded = mcpServers.get(row.id);
        if (superseded !== undefined) void closeMcpServer(row.id, superseded);

        const tools = buildTools(row.id, row.workspaceId, bus, contextStore, fileClaims, contracts);
        const handle = createMcpServer(row.id, tools);
        mcpServers.set(row.id, handle);
        await handle.ready();
      } catch (err) {
        process.stderr.write(`crossweave: could not start MCP server for session ${row.name}: ${String(err)}\n`);
      }

      return sessions.resolve(row.workspaceId, row.id);
    } finally {
      starting.delete(row.id);
    }
  }

  return {
    ping: () => ({ ok: true }),

    'workspace.init': (p) => workspaces.init(projectRoot, optionalStr(p, 'name')),
    'workspace.list': () => workspaces.list(),
    'workspace.info': (p) => workspaces.info(str(p, 'id')),
    'workspace.delete': (p) => {
      workspaces.delete(str(p, 'id'), { force: bool(p, 'force', false) });
      return { ok: true };
    },
    'workspace.gc': async (p) => collectGarbage(db, str(p, 'id')),
    'workspace.setSafeMode': (p) => workspaces.setSafeMode(str(p, 'id'), str(p, 'tier')),

    'session.new': (p) =>
      sessions.create({
        workspaceId: str(p, 'workspaceId'),
        name: str(p, 'name'),
        agent: str(p, 'agent'),
        worktree: bool(p, 'worktree', true),
        budgetTokens: optionalNum(p, 'budgetTokens'),
        budgetUsd: optionalNum(p, 'budgetUsd'),
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
    'session.rm': async (p) => {
      await sessions.remove(str(p, 'workspaceId'), str(p, 'idOrName'));
      return { ok: true };
    },

    'session.start': (p) => start(p),

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

    // No workspaceId in the params, deliberately: this is a high-frequency,
    // best-effort call (Claude Code's statusLine fires after every assistant
    // message, debounced 300ms) and the caller already knows the exact session
    // id — resolving through `sessions.resolve` would add a workspace lookup with
    // no purpose. An unknown sessionId is a silent no-op (recordUsage's own
    // contract), matching this call's "never block the agent" bar.
    'session.reportUsage': async (p) => {
      recordUsage({ sessions: sessionsRepo }, {
        sessionId: str(p, 'sessionId'),
        tokensUsed: optionalNum(p, 'tokensUsed'),
        costUsd: optionalNum(p, 'costUsd'),
      });
      return { ok: true };
    },

    // Awaited, so a caller told the session stopped can trust that it actually is.
    'session.stop': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      // Captured BEFORE the await, not after: this stop is responsible for the server
      // that was this session's when it was asked to stop. A `session.resume` landing
      // while `runtime.stop` is in flight installs a NEW one, and re-reading the map
      // afterwards would close that instead — leaving the resumed session with a
      // socket nothing can connect to.
      const handle = mcpServers.get(row.id);
      radarWatchers.stop(row.id);
      await runtime.stop(row.id);
      leaseManager.release(row.id);
      if (handle !== undefined) await closeMcpServer(row.id, handle);
      return { ok: true };
    },

    blame: (p) => {
      const result = ledger.blame(str(p, 'workspaceId'), str(p, 'file'), num(p, 'line'));
      return result ?? null;
    },

    'radar.check': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const sessionId = str(p, 'sessionId');
      const symbol = optionalStr(p, 'symbol');
      // Session NAMES are a display concern, added here where `sessions` is already in
      // scope, for the one consumer that needs a human-readable name: the hook's
      // advisory text. The blocking POLICY itself lives in decideBlocked, not here —
      // see its own doc comment for why (M5b's ACP permission handler needs the
      // identical decision, in-process, with no transport of its own).
      const { collisions, blocked } = decideBlocked(
        { fileClaims, workspaces, sessions },
        { workspaceId, sessionId, path: str(p, 'path'), symbol },
      );
      return {
        blocked,
        collisions: collisions.map((c) => ({
          ...c,
          sessionName: sessions.resolve(workspaceId, c.sessionId).name,
        })),
      };
    },

    'contract.declare': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const owner = sessions.resolve(workspaceId, str(p, 'sessionId'));
      const symbolFqn = str(p, 'symbolFqn');
      // Resolved from the OWNER's own worktree, never a client-supplied
      // `source` — `checkAndNotify` later recomputes sig_hash from that same
      // worktree, and a client-supplied source (e.g. the CLI's main-checkout
      // read) can diverge from it, firing a spurious "Contract changed" on
      // the very first watcher tick after declaring.
      const { path } = parseFqn(symbolFqn);
      const worktreePath = owner.worktreePath ?? projectRoot;
      // `path` comes from a client-supplied symbolFqn — never trust it to
      // stay inside the resolved worktree without checking.
      const source = readFileSync(assertContained(worktreePath, join(worktreePath, path)), 'utf8');
      const contract = contracts.declareFromSource(
        {
          workspaceId,
          ownerSession: owner.id,
          symbolFqn,
          stableBy: optionalStr(p, 'stableBy'),
        },
        source,
      );
      return { id: contract.id, symbolFqn: contract.symbolFqn, sigHash: contract.sigHash };
    },

    'session.mcpInfo': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      const handle = mcpServers.get(row.id);
      // `handle` existing only means `createMcpServer` was called and didn't throw —
      // it never throws on a bind failure (see src/mcp/server.ts), so `listening()`
      // is the only thing that reflects whether the socket is actually reachable.
      if (handle === undefined || !handle.listening()) {
        throw new CrossweaveError('MCP_SERVER_NOT_RUNNING', `No MCP server is running for session ${row.name}`);
      }
      return { mcpSocketPath: handle.socketPath };
    },

    'converge.status': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const trials = new MergeTrialRepo(db).listByWorkspace(workspaceId);
      const active = sessions
        .list(workspaceId)
        .filter((s) => s.agentKind !== 'integration' && (s.status === 'running' || s.status === 'idle') && s.branch !== null);

      const graph = buildConflictGraph(trials);
      const order = recommendOrder(active, graph);
      const pairwise: { a: string; b: string; result: string }[] = [];
      const seen = new Set<string>();
      for (const trial of [...trials].reverse()) {
        if (trial.branches.length !== 2) continue;
        const key = [...trial.branches].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        pairwise.push({ a: trial.branches[0] as string, b: trial.branches[1] as string, result: trial.result });
      }
      const fullIntegration = [...trials].reverse().find((t) => t.branches.length > 2) ?? null;
      const degraded = active.length > config.converge.pairwiseSessionThreshold;
      // `recommendedOrder` is an ordering of every active session, conflicts and
      // all — it is not a filter. `cw land all` needs the actual conflict-free
      // subset (degree 0 in the conflict graph) so it can land what it safely can
      // instead of attempting a session that was never going to land cleanly and
      // halting everyone after it in the order.
      const conflictFree = order.filter((s) => (graph.get(s.branch ?? '')?.size ?? 0) === 0).map((s) => s.name);

      return {
        pairwise,
        fullIntegration: fullIntegration
          ? { result: fullIntegration.result, ts: fullIntegration.ts, detail: fullIntegration.detail }
          : null,
        recommendedOrder: order.map((s) => s.name),
        conflictFree,
        degraded,
      };
    },

    'land.session': async (p) => {
      const workspaceId = str(p, 'workspaceId');
      const target = sessions.resolve(workspaceId, str(p, 'idOrName'));
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
      return landSession(
        { db, projectRoot, sessions: sessionsRepo, leaseManager, ledger, config, configTrust },
        workspaceId, target.id, { force },
      );
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
          collision: n?.collision ?? true,
          blocked: n?.blocked ?? true,
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
      return notifyConfig.get(workspaceId) ?? { workspaceId, enabled: true, collision: true, blocked: true, land: true, convergence: true };
    },

    'config.untrust': (p) => {
      configTrust.clear(str(p, 'workspaceId'));
      return { trusted: false };
    },

    'daemon.shutdown': async () => {
      convergenceScheduler.stop();
      radarWatchers.stopAll();
      await runtime.stopAll();
      // stopAll's exit callbacks have already begun closing most of these; anything
      // still registered is closed here, and both sets of closes are awaited through
      // `closingMcpServers` so a shutdown never races ahead of one in flight.
      for (const [sessionId, handle] of [...mcpServers]) void closeMcpServer(sessionId, handle);
      await Promise.all([...closingMcpServers]);
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },
  };
}
