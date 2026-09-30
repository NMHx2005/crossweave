import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../core/errors.js';
import type { CrossweaveConfig } from '../core/config.js';
import { assertContained, crossweaveDir } from '../core/paths.js';
import { LeaseRepo } from '../db/repositories/lease.js';
import { SessionRepo } from '../db/repositories/session.js';
import { WorkspaceRepo } from '../db/repositories/workspace.js';

export interface DiskUsage {
  sessionId: string;
  name: string;
  bytes: number;
}

/**
 * Recursive size in bytes. Returns 0 for a path that is gone rather than throwing.
 *
 * The `existsSync` + `readdirSync` pair is guarded, not just the recursive calls: the
 * OUTERMOST call runs from `measureWorktrees` on `session.new`, which the daemon
 * dispatches concurrently with the boot-time orphan sweep's `git worktree remove` on
 * those very paths. Without the try/catch an ENOENT between the two syscalls escaped
 * as an uncaught internal error instead of the clean `CODE:` line the CLI contract
 * promises — and the doc line above already claimed otherwise.
 *
 * The catch is deliberately type-blind: an EACCES directory is counted as zero too.
 * Refusing to start a session because one unreadable subdirectory cannot be sized is
 * worse than under-counting it, and the guard's job is to catch runaway growth, not to
 * audit permissions.
 */
export function directorySize(path: string): number {
  let entries;
  try {
    if (!existsSync(path)) return 0;
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(child);
      else if (entry.isFile()) total += statSync(child).size;
      // Symlinks are counted as zero: following them would double-count, and a link
      // out of the worktree is not this worktree's disk.
    } catch {
      // A file that vanished mid-walk is not an error — an agent is writing here.
    }
  }
  return total;
}

/**
 * The directories that count as one session's disk: its own worktree, plus the cache and database directories or files its
 * leases point at inside the workspace's `.crossweave` (a lease path that is missing, escapes it or is not absolute
 * contributes nothing). A shared session (its "worktree" IS the project root: the user's own files) has none.
 */
export function sessionDiskPaths(
  workspaceRoot: string | undefined,
  session: { id: string; worktreePath: string | null },
  leases: LeaseRepo,
): string[] {
  if (session.worktreePath === null || session.worktreePath === workspaceRoot) return [];
  const paths = [session.worktreePath];
  const leaseRoot = workspaceRoot === undefined ? undefined : crossweaveDir(workspaceRoot);
  if (leaseRoot === undefined) return paths;
  for (const lease of leases.listBySession(session.id)) {
    if ((lease.kind !== 'cache' && lease.kind !== 'db') || !isAbsolute(lease.value)) continue;
    try {
      const path = assertContained(leaseRoot, lease.value);
      if (!paths.includes(path)) paths.push(path);
    } catch {
      // An escaped or malformed lease path contributes no bytes.
    }
  }
  return paths;
}

export function measureWorktrees(db: Database, workspaceId: string): DiskUsage[] {
  const workspace = new WorkspaceRepo(db).findById(workspaceId);
  const leases = new LeaseRepo(db);

  return new SessionRepo(db)
    .listByWorkspace(workspaceId)
    // A shared session's "worktree" IS the project root: the user's own files, not disk
    // crossweave created, and often tens of GB. Only a worktree of its own is measured.
    .filter((s) => s.worktreePath !== null && s.worktreePath !== workspace?.rootPath)
    .map((s) => {
      const [worktree, ...extras] = sessionDiskPaths(workspace?.rootPath, s, leases);
      let bytes = directorySize(worktree ?? '');
      for (const path of extras) {
        try {
          const stat = statSync(path);
          bytes += stat.isDirectory() ? directorySize(path) : stat.isFile() ? stat.size : 0;
        } catch {
          // Missing and unreadable lease paths contribute no bytes.
        }
      }
      return { sessionId: s.id, name: s.name, bytes };
    });
}

/** Short human-readable size, for messages a person reads rather than parses. */
export function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)}${units[unit]}`;
}

/**
 * Refuse to start another session when the disk is already over budget.
 *
 * The failure this prevents is not subtle: a 2 GB checkout was measured consuming
 * 9.8 GB of worktrees in twenty minutes. Refusing early, naming the offender, and
 * pointing at `cw gc` is far kinder than a full disk.
 */
export function assertDiskAvailable(
  db: Database,
  workspaceId: string,
  config: CrossweaveConfig,
): void {
  const usage = measureWorktrees(db, workspaceId);

  const worst = usage.reduce<DiskUsage | undefined>(
    (max, u) => (max === undefined || u.bytes > max.bytes ? u : max),
    undefined,
  );
  if (worst !== undefined && worst.bytes > config.disk.perSessionBytes) {
    throw new CrossweaveError(
      'DISK_LIMIT_EXCEEDED',
      `Session ${worst.name} holds ${humanBytes(worst.bytes)}, over the ` +
        `${humanBytes(config.disk.perSessionBytes)} per-session limit. ` +
        'Run `cw gc` to reclaim ended sessions, or raise disk.perSessionBytes.',
    );
  }

  const total = usage.reduce((sum, u) => sum + u.bytes, 0);
  if (total > config.disk.perWorkspaceBytes) {
    throw new CrossweaveError(
      'DISK_LIMIT_EXCEEDED',
      `Worktrees hold ${humanBytes(total)} in total, over the ` +
        `${humanBytes(config.disk.perWorkspaceBytes)} workspace limit. ` +
        'Run `cw gc` to reclaim ended sessions, or raise disk.perWorkspaceBytes.',
    );
  }
}
