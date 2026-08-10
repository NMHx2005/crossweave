import { execFileSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { EventRepo, type EventRow } from '../db/repositories/event.js';
import { SessionRepo } from '../db/repositories/session.js';

export interface BlameResult {
  sessionId: string;
  sessionName: string;
  commitHash: string;
}

/**
 * Records session lifecycle and commit events, and answers `cw blame`.
 *
 * There is no hook yet that observes an agent's individual tool calls or file
 * writes — that is M3's `PreToolUse` plumbing. What this CAN know without a hook is
 * git's own history: every commit made on a session's branch. `blame()` backfills
 * that history lazily (idempotent — safe before every call) and answers from it.
 * A line that has not been committed yet has no session to attribute it to under
 * this design; `blame()` returns `undefined` for it rather than guessing.
 *
 * A session's own worktree is the only place a fresh file exists before it's
 * landed (M4), so plain `git blame` against `projectRoot`'s checked-out state
 * cannot see it — the file was never checked out THERE. Every git call here uses
 * `<revision>:<path>` addressing (a branch name passed straight to `git blame`)
 * instead, which reads directly from git's object database and needs nothing
 * checked out anywhere.
 */
export class EventLedger {
  private readonly events: EventRepo;
  private readonly sessions: SessionRepo;

  constructor(
    private readonly db: Database,
    private readonly projectRoot: string,
  ) {
    this.events = new EventRepo(db);
    this.sessions = new SessionRepo(db);
  }

  append(row: Omit<EventRow, 'id' | 'ts'>): void {
    this.events.insert({ ...row, id: newId('ev'), ts: new Date().toISOString() });
  }

  private knownCommitHashes(sessionId: string): Set<string> {
    const hashes = new Set<string>();
    for (const ev of this.events.listBySession(sessionId)) {
      if (ev.kind !== 'commit.made') continue;
      try {
        const payload = JSON.parse(ev.payload) as { commitHash?: string };
        if (typeof payload.commitHash === 'string') hashes.add(payload.commitHash);
      } catch {
        // Malformed payload from a future format — skip, don't crash blame over it.
      }
    }
    return hashes;
  }

  /**
   * The branch currently checked out in `projectRoot` — every session's branch was
   * created from wherever this pointed at session-creation time, so it's the
   * boundary between "shared, pre-existing history" and "this session's own work".
   * `undefined` on a detached HEAD (no usable base) or if git fails outright.
   */
  private baseBranch(): string | undefined {
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return branch === 'HEAD' ? undefined : branch;
    } catch {
      return undefined;
    }
  }

  /**
   * For every session with a branch, record any commit that's on that branch but
   * NOT on the base branch — i.e. commits the session itself made, not history it
   * inherited at fork time (which would otherwise get attributed to every session
   * that happens to share that ancestry). Safe to call repeatedly:
   * `knownCommitHashes` makes it a no-op for history it's already recorded.
   */
  private syncCommits(workspaceId: string): void {
    const base = this.baseBranch();
    if (base === undefined) return;

    for (const session of this.sessions.listByWorkspace(workspaceId)) {
      if (session.branch === null || session.branch === base) continue;

      let hashes: string[];
      try {
        const out = execFileSync('git', ['log', `${base}..${session.branch}`, '--format=%H'], {
          cwd: this.projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        hashes = out.split('\n').map((h) => h.trim()).filter(Boolean);
      } catch {
        // Branch may not exist any more (session fully removed) — nothing to sync.
        continue;
      }

      const known = this.knownCommitHashes(session.id);
      for (const hash of hashes) {
        if (known.has(hash)) continue;
        this.append({
          sessionId: session.id,
          workspaceId,
          kind: 'commit.made',
          payload: JSON.stringify({ commitHash: hash }),
        });
        known.add(hash);
      }
    }
  }

  /** Blames `filePath` at `line` as it exists on `revision` — no checkout needed. */
  private blameAt(revision: string, filePath: string, line: number): string | undefined {
    try {
      const out = execFileSync(
        'git',
        ['blame', revision, `-L${line},${line}`, '--porcelain', '--', filePath],
        { cwd: this.projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const firstLine = out.split('\n')[0] ?? '';
      const hash = firstLine.slice(0, 40).trim();
      // All-zeros hash means the line is uncommitted on this revision.
      return !hash || /^0+$/.test(hash) ? undefined : hash;
    } catch {
      // Path doesn't exist on this revision at all — not an error, just not here.
      return undefined;
    }
  }

  blame(workspaceId: string, filePath: string, line: number): BlameResult | undefined {
    this.syncCommits(workspaceId);

    const base = this.baseBranch();
    const sessions = this.sessions.listByWorkspace(workspaceId);
    const revisions = [
      ...(base !== undefined ? [base] : []),
      ...sessions.map((s) => s.branch).filter((b): b is string => b !== null),
    ];

    for (const revision of revisions) {
      const commitHash = this.blameAt(revision, filePath, line);
      if (commitHash === undefined) continue; // not found on this revision — try the next
      for (const session of sessions) {
        if (this.knownCommitHashes(session.id).has(commitHash)) {
          return { sessionId: session.id, sessionName: session.name, commitHash };
        }
      }
      return undefined; // a real commit, found — but not made by any tracked session
    }
    return undefined; // not found on any known revision, or genuinely uncommitted everywhere
  }
}
