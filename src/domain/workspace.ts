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

  init(projectRoot: string, name?: string): WorkspaceRow {
    const existing = this.workspaces.findByRoot(projectRoot);
    if (existing) return existing;

    const row: WorkspaceRow = {
      id: newId('ws'),
      name: name ?? basename(projectRoot),
      rootPath: projectRoot,
      createdAt: new Date().toISOString(),
      defaultIsolation: 'worktree',
      safeModeTier: 'T3',
    };
    this.workspaces.insert(row);
    return row;
  }

  list(): WorkspaceRow[] {
    return this.workspaces.list();
  }

  resolve(nameOrId: string): WorkspaceRow {
    const found = this.workspaces.findById(nameOrId) ?? this.workspaces.findByName(nameOrId);
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
