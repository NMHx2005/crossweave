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
