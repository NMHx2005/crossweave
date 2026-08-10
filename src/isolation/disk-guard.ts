import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../core/errors.js';
import type { CrossweaveConfig } from '../core/config.js';
import { SessionRepo } from '../db/repositories/session.js';

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

export function measureWorktrees(db: Database, workspaceId: string): DiskUsage[] {
  return new SessionRepo(db)
    .listByWorkspace(workspaceId)
    .filter((s) => s.worktreePath !== null)
    .map((s) => ({
      sessionId: s.id,
      name: s.name,
      bytes: directorySize(s.worktreePath ?? ''),
    }));
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
