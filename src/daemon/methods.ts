import type { Database } from 'bun:sqlite';
import { WorkspaceManager } from '../domain/workspace.js';
import { SessionManager, type AdapterFactory } from '../domain/session.js';
import { CrossweaveError } from '../core/errors.js';
import { SessionRuntime } from './runtime.js';
import type { MethodHandler } from './server.js';
import type { SessionRow } from '../db/repositories/session.js';

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
    'session.rm': async (p) => {
      await sessions.remove(str(p, 'workspaceId'), str(p, 'idOrName'));
      return { ok: true };
    },

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
