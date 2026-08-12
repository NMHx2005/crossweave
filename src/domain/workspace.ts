import { realpathSync } from 'node:fs';
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

  /**
   * `root_path` is the identity of a workspace, so it has to be compared in one
   * spelling. A path that exists on disk gets canonicalised; one that does not cannot
   * be a symlink alias for anything, so it is used as written — which is also what
   * keeps this function filesystem-free for callers that pass a path that is not
   * there yet.
   */
  private static canonicalRoot(projectRoot: string): string {
    try {
      return realpathSync(projectRoot);
    } catch {
      return projectRoot;
    }
  }

  /**
   * Idempotent for a given root. Passing a different `name` for a root that already
   * exists returns the existing row unchanged rather than renaming it — rename is
   * `workspace rename`'s job, not init's.
   */
  init(projectRoot: string, name?: string): WorkspaceRow {
    const root = WorkspaceManager.canonicalRoot(projectRoot);
    const existing = this.workspaces.findByRoot(root);
    if (existing) return existing;

    const row: WorkspaceRow = {
      id: newId('ws'),
      name: name ?? basename(root),
      rootPath: root,
      createdAt: new Date().toISOString(),
      defaultIsolation: 'worktree',
      safeModeTier: 'T2',
    };

    try {
      this.workspaces.insert(row);
    } catch (cause) {
      // Another process inserted this root between our read and our write. The
      // UNIQUE constraint on root_path is what makes that safe to recover from;
      // without this the caller would get a raw SQLiteError naming a table column.
      const raced = this.workspaces.findByRoot(root);
      if (raced) return raced;
      throw new CrossweaveError(
        'WORKSPACE_INIT_FAILED',
        `Could not create workspace at ${root}: ${(cause as Error).message}`,
      );
    }
    return row;
  }

  list(): WorkspaceRow[] {
    return this.workspaces.list();
  }

  /**
   * Id wins over name. Names are NOT unique in the schema, and `delete` is built on
   * this — silently picking the first of several same-named workspaces would delete
   * one the caller did not mean. Ambiguity therefore fails closed and demands an id.
   */
  resolve(nameOrId: string): WorkspaceRow {
    const byId = this.workspaces.findById(nameOrId);
    if (byId) return byId;

    const byName = this.workspaces.list().filter((w) => w.name === nameOrId);
    if (byName.length > 1) {
      throw new CrossweaveError(
        'WORKSPACE_NAME_AMBIGUOUS',
        `${byName.length} workspaces are named ${nameOrId}: ` +
          `${byName.map((w) => `${w.id} (${w.rootPath})`).join(', ')}. Use the id instead.`,
      );
    }

    const found = byName[0];
    if (!found) {
      throw new CrossweaveError('WORKSPACE_NOT_FOUND', `No such workspace: ${nameOrId}`);
    }
    return found;
  }

  info(id: string): WorkspaceInfo {
    const workspace = this.resolve(id);
    // The integration session (Task 2's convergence-engine scratch worktree) is
    // infrastructure, not something a user ever interacts with — `SessionManager.list`
    // already filters it out, and `cw workspace info` must not leak it either.
    const sessions = this.sessions
      .listByWorkspace(workspace.id)
      .filter((s) => s.agentKind !== 'integration');
    return { workspace, sessions };
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

  private static readonly SETTABLE_SAFE_MODE_TIERS = new Set<WorkspaceRow['safeModeTier']>(['T2', 'T3']);

  /**
   * T1 is rejected outright rather than silently accepted as if it were T2: no
   * ACP-based adapter exists yet (M5a's scope), and accepting it would tell the
   * user they have stronger enforcement than the system can actually provide.
   */
  setSafeMode(idOrName: string, tier: string): WorkspaceRow {
    const workspace = this.resolve(idOrName);
    if (tier === 'T1') {
      throw new CrossweaveError(
        'SAFE_MODE_TIER_UNAVAILABLE',
        'T1 requires an ACP-based adapter, which crossweave does not have yet. Use T2 or T3.',
      );
    }
    if (!WorkspaceManager.SETTABLE_SAFE_MODE_TIERS.has(tier as WorkspaceRow['safeModeTier'])) {
      throw new CrossweaveError('INVALID_PARAMS', `safeModeTier must be T2 or T3, got: ${tier}`);
    }
    this.workspaces.updateSafeModeTier(workspace.id, tier as WorkspaceRow['safeModeTier']);
    return { ...workspace, safeModeTier: tier as WorkspaceRow['safeModeTier'] };
  }
}
