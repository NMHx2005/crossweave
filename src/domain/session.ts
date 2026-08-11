import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { WorkspaceRepo } from '../db/repositories/workspace.js';
import { SessionRepo, type SessionRow } from '../db/repositories/session.js';
import { EventRepo } from '../db/repositories/event.js';
import { createWorktree, deleteBranch, removeWorktree } from '../isolation/worktree.js';
import { assertDiskAvailable } from '../isolation/disk-guard.js';
import { createAdapter as defaultCreateAdapter } from '../adapters/registry.js';
import type { AgentAdapter } from '../adapters/types.js';
import { DEFAULT_CONFIG, type CrossweaveConfig } from '../core/config.js';

export type AdapterFactory = (kind: string) => AgentAdapter;

export interface CreateSessionOptions {
  workspaceId: string;
  name: string;
  agent: string;
  worktree: boolean;
}

/**
 * A session name becomes a git branch (`cw/<name>`) and a column in a tab-delimited
 * listing the TUI parses. Letting an arbitrary string through means git rejects it
 * downstream and its own multi-line stderr surfaces as several lines with no `CODE:`
 * prefix, which breaks the CLI's one parseable-error contract. Dots are excluded
 * rather than special-cased: `..` and a trailing `.lock` are both invalid refs, and
 * no realistic session name needs one.
 */
const VALID_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_SESSION_NAME = 64;

/**
 * The Convergence Engine's scratch worktree (Task 2) is backed by a real
 * session row so `lease.session_id`'s foreign key has something to point
 * at. This name is reserved so a user can never accidentally (or
 * maliciously) claim it and shadow the engine's own row.
 */
export const RESERVED_SESSION_NAME = '__integration__';

function assertValidSessionName(name: string): void {
  if (name === RESERVED_SESSION_NAME) {
    throw new CrossweaveError('INVALID_SESSION_NAME', `"${RESERVED_SESSION_NAME}" is reserved for internal use`);
  }
  if (name.length > MAX_SESSION_NAME || !VALID_SESSION_NAME.test(name)) {
    throw new CrossweaveError(
      'INVALID_SESSION_NAME',
      `Session name must be 1-${MAX_SESSION_NAME} characters of letters, digits, ` +
        `dash or underscore and start with a letter or digit, got ${JSON.stringify(name)}`,
    );
  }
}

export class SessionManager {
  private readonly sessions: SessionRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly events: EventRepo;

  /** Set by the daemon so kill() can stop a live pty it does not own. */
  onKill?: (sessionId: string) => Promise<void>;

  constructor(
    private readonly db: Database,
    private readonly adapterFactory: AdapterFactory = defaultCreateAdapter,
    private readonly config: CrossweaveConfig = DEFAULT_CONFIG,
  ) {
    this.sessions = new SessionRepo(db);
    this.workspaces = new WorkspaceRepo(db);
    this.events = new EventRepo(db);
  }

  private projectRoot(workspaceId: string): string {
    const ws = this.workspaces.findById(workspaceId);
    if (!ws) throw new CrossweaveError('WORKSPACE_NOT_FOUND', `No such workspace: ${workspaceId}`);
    return ws.rootPath;
  }

  async create(opts: CreateSessionOptions): Promise<SessionRow> {
    assertValidSessionName(opts.name);
    // Checked before the worktree is created, not after: the whole point is to refuse
    // before adding another full checkout to a disk that is already over budget.
    assertDiskAvailable(this.db, opts.workspaceId, this.config);
    const root = this.projectRoot(opts.workspaceId);

    if (this.sessions.findByName(opts.workspaceId, opts.name)) {
      throw new CrossweaveError('SESSION_NAME_TAKEN', `Session already exists: ${opts.name}`);
    }

    const adapter = this.adapterFactory(opts.agent);
    const id = newId('s');

    let worktreePath = root;
    let branch: string | null = null;
    let forkPoint: string | null = null;
    if (opts.worktree) {
      const handle = await createWorktree(root, id, `cw/${opts.name}`);
      worktreePath = handle.path;
      branch = handle.branch;
      forkPoint = handle.forkPoint;
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

    // Recorded once, here, and never recomputed: this is the boundary between history
    // the session inherited and work it did itself. Deriving it later from the branch
    // checked out in the user's own checkout attributes their commits to this session
    // the moment they switch branches, permanently (the event table is append-only).
    if (forkPoint !== null) {
      this.events.insert({
        id: newId('ev'),
        sessionId: id,
        workspaceId: opts.workspaceId,
        ts: now,
        kind: 'session.forked',
        payload: JSON.stringify({ forkPoint }),
      });
    }
    return row;
  }

  list(workspaceId: string): SessionRow[] {
    return this.sessions.listByWorkspace(workspaceId).filter((s) => s.agentKind !== 'integration');
  }

  adapterFor(kind: string): AgentAdapter {
    return this.adapterFactory(kind);
  }

  markStatus(id: string, status: SessionRow['status'], pid: number | null): void {
    this.sessions.updateStatus(id, status, pid);
  }

  /**
   * The agent process ended. Called from the runtime's ASYNCHRONOUS exit handler, so
   * it must not clobber a terminal state.
   *
   * The original race is no longer reachable — `kill()` now awaits `onKill` before
   * writing `dead`, so the exit callback has already run by then. The guard stays as
   * defence in depth: any future caller that writes a terminal state without awaiting
   * the reap would reintroduce it, and the failure mode is `cw session list` reporting
   * a killed session as `idle`.
   */
  clearRunning(id: string): void {
    const row = this.sessions.findById(id);
    if (!row) return;
    if (row.status === 'dead' || row.status === 'landed') return;
    this.sessions.updateStatus(id, 'idle', null);
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
    assertValidSessionName(newName);
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

    // Awaited: kill must not report success while the agent is still alive, and the
    // pid must not be cleared until the process is confirmed gone — otherwise nothing
    // can ever find or reap it again.
    await this.onKill?.(row.id);

    // A shared session points at the project root, which must never be removed.
    const ownWorktree =
      row.worktreePath !== null && row.worktreePath !== root ? row.worktreePath : null;

    if (opts.removeWorktree && ownWorktree !== null) {
      await removeWorktree(root, ownWorktree);
      if (row.branch !== null) await deleteBranch(root, row.branch).catch(() => undefined);
      // Removing the worktree means the work is gone, so nothing is left for the row
      // to describe — and keeping it would hold the name hostage under
      // UNIQUE(workspace_id, name) with no way to reclaim it.
      this.sessions.delete(row.id);
      return;
    }

    this.sessions.updateStatus(row.id, 'dead', null);
  }

  /**
   * Purge a session that has already ended: its worktree, its branch and its row.
   *
   * Refuses a live session outright rather than killing it first — deleting a running
   * agent's record without stopping the agent would strand the process, and silently
   * killing something the caller only asked to remove is worse.
   */
  async remove(workspaceId: string, idOrName: string): Promise<void> {
    const row = this.resolve(workspaceId, idOrName);
    if (row.status !== 'dead' && row.status !== 'landed') {
      throw new CrossweaveError(
        'SESSION_STILL_LIVE',
        `Session ${row.name} is ${row.status}. Kill it before removing it.`,
      );
    }

    const root = this.projectRoot(workspaceId);
    const ownWorktree =
      row.worktreePath !== null && row.worktreePath !== root ? row.worktreePath : null;

    if (ownWorktree !== null) await removeWorktree(root, ownWorktree).catch(() => undefined);
    if (row.branch !== null) await deleteBranch(root, row.branch).catch(() => undefined);
    this.sessions.delete(row.id);
  }
}
