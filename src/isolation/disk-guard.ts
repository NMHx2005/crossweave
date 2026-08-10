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

/** Recursive size in bytes. Returns 0 for a path that is gone rather than throwing. */
export function directorySize(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
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

function human(bytes: number): string {
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
      `Session ${worst.name} holds ${human(worst.bytes)}, over the ` +
        `${human(config.disk.perSessionBytes)} per-session limit. ` +
        'Run `cw gc` to reclaim ended sessions, or raise disk.perSessionBytes.',
    );
  }

  const total = usage.reduce((sum, u) => sum + u.bytes, 0);
  if (total > config.disk.perWorkspaceBytes) {
    throw new CrossweaveError(
      'DISK_LIMIT_EXCEEDED',
      `Worktrees hold ${human(total)} in total, over the ` +
        `${human(config.disk.perWorkspaceBytes)} workspace limit. ` +
        'Run `cw gc` to reclaim ended sessions, or raise disk.perWorkspaceBytes.',
    );
  }
}
