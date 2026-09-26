import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CrossweaveError } from '../core/errors.js';

export type FileChangeStatus = 'added' | 'modified' | 'deleted';

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  /** Lines; 0 for a binary file, which git does not count. */
  added: number;
  deleted: number;
}

export interface SessionDiff {
  files: FileChange[];
  /** The unified diff, cut at `maxPatchBytes`. */
  patch: string;
  truncated: boolean;
  /** Files changed in the worktree but not committed — landing will not take them. */
  uncommitted: number;
}

const DEFAULT_MAX_PATCH_BYTES = 512 * 1024;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

const STATUS: Record<string, FileChangeStatus> = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' };

/**
 * What landing `branch` would bring in: its commits since it left the base (the
 * merge-base with the project's HEAD), never the base's own later commits — a plain
 * `HEAD..branch` diff would show those as the session "deleting" them. This is the
 * data the land decision needs, shown before the land rather than after.
 */
export function sessionDiff(
  projectRoot: string,
  branch: string,
  worktreePath: string | null,
  opts: { maxPatchBytes?: number } = {},
): SessionDiff {
  const ref = `refs/heads/${branch}`;
  let from: string;
  try {
    from = git(projectRoot, ['merge-base', 'HEAD', ref]).trim();
  } catch {
    throw new CrossweaveError('DIFF_UNAVAILABLE', `No diff for ${branch}: the branch or the base could not be read.`);
  }
  const range = `${from}..${ref}`;
  // --no-renames: a rename reads as delete + add, one path per line, nothing to parse.
  const counts = new Map<string, { added: number; deleted: number }>();
  for (const line of git(projectRoot, ['diff', '--no-renames', '--numstat', range]).split('\n')) {
    const [a, d, ...rest] = line.split('\t');
    if (rest.length === 0) continue;
    counts.set(rest.join('\t'), { added: Number(a) || 0, deleted: Number(d) || 0 });
  }
  const files: FileChange[] = [];
  for (const line of git(projectRoot, ['diff', '--no-renames', '--name-status', range]).split('\n')) {
    const [code, ...rest] = line.split('\t');
    if (code === undefined || rest.length === 0) continue;
    const path = rest.join('\t');
    const c = counts.get(path) ?? { added: 0, deleted: 0 };
    files.push({ path, status: STATUS[code[0] ?? 'M'] ?? 'modified', ...c });
  }
  files.sort((x, y) => x.path.localeCompare(y.path));

  const max = opts.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const full = git(projectRoot, ['diff', '--no-renames', '--no-color', range]);
  const buf = Buffer.from(full);
  const truncated = buf.length > max;
  // Cut on a line boundary so the last line shown is a whole line.
  let patch = full;
  if (truncated) {
    const cut = buf.subarray(0, max).toString('utf8');
    patch = cut.slice(0, cut.lastIndexOf('\n') + 1);
  }

  let uncommitted = 0;
  if (worktreePath !== null && existsSync(worktreePath)) {
    try {
      uncommitted = git(worktreePath, ['status', '--porcelain']).split('\n').filter((l) => l !== '').length;
    } catch {
      uncommitted = 0;
    }
  }
  return { files, patch, truncated, uncommitted };
}
