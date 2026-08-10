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
 * cannot see it — the file was never checked out THERE. Every git call here passes
 * a revision (a branch name) plus a `-- <path>` pathspec straight to `git blame` /
 * `git log` — e.g. `git blame <branch> -- <path>` — instead of touching the working
 * tree. That reads directly from git's object database and needs nothing checked
 * out anywhere.
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

  /**
   * One pass over a session's events for both things blame needs from them: the
   * immutable fork point recorded at session creation, and every commit already
   * attributed to it.
   */
  private history(sessionId: string): { forkPoint: string | undefined; commitHashes: Set<string> } {
    let forkPoint: string | undefined;
    const commitHashes = new Set<string>();
    for (const ev of this.events.listBySession(sessionId)) {
      if (ev.kind !== 'commit.made' && ev.kind !== 'session.forked') continue;
      try {
        const payload = JSON.parse(ev.payload) as { commitHash?: string; forkPoint?: string };
        if (ev.kind === 'commit.made') {
          if (typeof payload.commitHash === 'string') commitHashes.add(payload.commitHash);
        } else if (typeof payload.forkPoint === 'string' && payload.forkPoint.length > 0) {
          forkPoint = payload.forkPoint;
        }
      } catch {
        // Malformed payload from a future format — skip, don't crash blame over it.
      }
    }
    return { forkPoint, commitHashes };
  }

  /**
   * The branch currently checked out in `projectRoot`. Used ONLY as one more revision
   * to try `git blame` against — never to decide which commits belong to a session,
   * which is what the recorded fork point is for.
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
   * For every session with a branch, record any commit on that branch that is not
   * reachable from its FORK POINT — i.e. commits the session itself made, not history
   * it inherited at fork time.
   *
   * The range is `<forkPoint>..<branch>`, where the fork point is the immutable hash
   * captured when the session's worktree was created. It is deliberately NOT derived
   * from whatever branch happens to be checked out in `projectRoot` at blame time: a
   * user who checks out an older branch in their own checkout while agents work in
   * worktrees would widen the range to include their own commits, and because this
   * table is append-only and deduplicated by hash, that misattribution would be
   * written once and never corrected.
   *
   * A session with no recorded fork point (created before this was tracked) is
   * skipped rather than guessed at — no attribution beats a wrong one. Safe to call
   * repeatedly: already-recorded hashes make it a no-op.
   */
  private syncCommits(workspaceId: string): void {
    for (const session of this.sessions.listByWorkspace(workspaceId)) {
      if (session.branch === null) continue;
      const { forkPoint, commitHashes: known } = this.history(session.id);
      if (forkPoint === undefined) continue;

      let hashes: string[];
      try {
        const out = execFileSync('git', ['log', `${forkPoint}..${session.branch}`, '--format=%H'], {
          cwd: this.projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        hashes = out.split('\n').map((h) => h.trim()).filter(Boolean);
      } catch {
        // Branch may not exist any more (session fully removed) — nothing to sync.
        continue;
      }

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
      // Defensive: an all-zeros hash is what a plain working-directory `git blame`
      // (no revision) reports for an uncommitted line. Blaming a REVISION (as we
      // always do here) can't produce it in practice — currently unreachable, kept
      // in case that ever changes — so this isn't what makes uncommitted-line
      // lookups return undefined; that happens via the catch below instead, when
      // the path doesn't exist on any revision at all.
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

    // Built once per call, not once per (revision, session) pair: the event table is
    // only read after syncCommits has finished writing to it, so one pass answers
    // every lookup below.
    const bySessionOf = new Map<string, { id: string; name: string }>();
    for (const session of sessions) {
      for (const hash of this.history(session.id).commitHashes) {
        if (!bySessionOf.has(hash)) bySessionOf.set(hash, { id: session.id, name: session.name });
      }
    }

    for (const revision of revisions) {
      const commitHash = this.blameAt(revision, filePath, line);
      if (commitHash === undefined) continue; // not found on this revision — try the next
      const owner = bySessionOf.get(commitHash);
      if (owner !== undefined) {
        return { sessionId: owner.id, sessionName: owner.name, commitHash };
      }
      // A real commit was found here, but not authored by any tracked session — keep
      // trying other revisions instead of giving up, since a later session's branch
      // may still hold the actual agent-authored edit to this same file/line.
    }
    return undefined; // no revision had a tracked-session match, or nothing was found anywhere
  }
}
