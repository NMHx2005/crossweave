import type { Database } from 'bun:sqlite';
import { WorkspaceManager } from '../domain/workspace.js';
import { SessionManager } from '../domain/session.js';
import type { MethodHandler } from './server.js';

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

export function buildMethods(
  db: Database,
  projectRoot: string,
): Record<string, MethodHandler> {
  const workspaces = new WorkspaceManager(db);
  const sessions = new SessionManager(db);

  return {
    ping: () => ({ ok: true }),
    'daemon.shutdown': () => {
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },

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
