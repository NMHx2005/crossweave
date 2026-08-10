import type { Database } from 'bun:sqlite';
import { WorkspaceManager } from '../domain/workspace.js';
import { SessionManager, type AdapterFactory } from '../domain/session.js';
import { CrossweaveError } from '../core/errors.js';
import { SessionRuntime } from './runtime.js';
import type { MethodHandler } from './server.js';
import type { SessionRow } from '../db/repositories/session.js';
import { LeaseManager } from '../isolation/leases/manager.js';
import { loadConfig, type CrossweaveConfig } from '../core/config.js';
import { collectGarbage, collectOrphans } from '../domain/gc.js';
import { EventLedger } from '../domain/ledger.js';
import { MessageBus } from '../domain/bus.js';
import { ContextStore } from '../domain/context-store.js';
import { reconcile } from '../domain/reconciliation.js';
import { createMcpServer, type McpServerHandle } from '../mcp/server.js';
import { buildTools } from '../mcp/tools.js';

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
): Record<string, MethodHandler> {
  const workspaces = new WorkspaceManager(db);
  const sessions = new SessionManager(db, adapterFactory, config);
  const leaseManager = new LeaseManager(db, projectRoot, config);
  // Nothing a previous daemon held can have survived its death, and a lease left
  // marked active would permanently shrink the pool.
  leaseManager.releaseAll();

  const ledger = new EventLedger(db, projectRoot);
  const bus = new MessageBus(db, sessions);
  const contextStore = new ContextStore(db);

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

  const mcpServers = new Map<string, McpServerHandle>();

  const runtime = new SessionRuntime((sessionId) => {
    sessions.clearRunning(sessionId);
    leaseManager.release(sessionId);
    const handle = mcpServers.get(sessionId);
    if (handle !== undefined) {
      void handle
        .close()
        .catch(() => undefined)
        .finally(() => mcpServers.delete(sessionId));
    }
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

      // Best effort: messaging/context tools are a real feature but not the reason
      // the session exists. A socket bind failure here (see mcpSocketPath's own
      // length guard, and main.ts's top-level handler) degrades this one session
      // to "no MCP tools available" rather than failing the whole start.
      try {
        const tools = buildTools(row.id, row.workspaceId, bus, contextStore);
        mcpServers.set(row.id, createMcpServer(row.id, tools));
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

    // Awaited, so a caller told the session stopped can trust that it actually is.
    'session.stop': async (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      await runtime.stop(row.id);
      leaseManager.release(row.id);
      const handle = mcpServers.get(row.id);
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
        mcpServers.delete(row.id);
      }
      return { ok: true };
    },

    blame: (p) => {
      const result = ledger.blame(str(p, 'workspaceId'), str(p, 'file'), num(p, 'line'));
      return result ?? null;
    },

    'session.mcpInfo': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      const handle = mcpServers.get(row.id);
      if (handle === undefined) {
        throw new CrossweaveError('MCP_SERVER_NOT_RUNNING', `No MCP server is running for session ${row.name}`);
      }
      return { mcpSocketPath: handle.socketPath };
    },

    'daemon.shutdown': async () => {
      await runtime.stopAll();
      await Promise.all([...mcpServers.values()].map((h) => h.close().catch(() => undefined)));
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },
  };
}
