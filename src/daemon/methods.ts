import type { Database } from 'bun:sqlite';
import { WorkspaceManager } from '../domain/workspace.js';
import { SessionManager, type AdapterFactory } from '../domain/session.js';
import { SessionRuntime } from './runtime.js';
import type { MethodHandler } from './server.js';
import type { SessionRow } from '../db/repositories/session.js';

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string') throw new TypeError(`Expected string param: ${key}`);
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
  if (typeof v !== 'number') throw new TypeError(`Expected number param: ${key}`);
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
    sessions.markStatus(sessionId, 'idle', null);
  });
  sessions.onKill = (id) => runtime.stop(id);

  function start(p: Record<string, unknown>): SessionRow {
    const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
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

    'session.start': (p) => start(p),

    'session.resume': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
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

    'session.stop': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      runtime.stop(row.id);
      return { ok: true };
    },

    'daemon.shutdown': () => {
      runtime.stopAll();
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },
  };
}
