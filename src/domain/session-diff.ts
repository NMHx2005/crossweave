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
  uncommitted: number | null;
}

const DEFAULT_MAX_PATCH_BYTES = 512 * 1024;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

const STATUS: Record<string, FileChangeStatus> = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' };

export type TreeDiff = Omit<SessionDiff, 'uncommitted'>;

/**
 * `git diff a b` for any two tree-ish values, parsed. Shared by `sessionDiff` (a commit range) and
 * checkpoints (two snapshot trees), so the numstat/name-status/truncation code exists once. Paths are read
 * NUL-terminated: without `-z` git C-quotes an accented or quoted name and the path stops matching the file.
 */
export function diffBetween(
  cwd: string,
  a: string,
  b: string,
  opts: { maxPatchBytes?: number; patch?: boolean } = {},
): TreeDiff {
  // --no-renames: a rename reads as delete + add, one path per record, nothing to parse.
  const counts = new Map<string, { added: number; deleted: number }>();
  for (const record of git(cwd, ['diff', '--no-renames', '--numstat', '-z', a, b]).split('\0')) {
    const [added, deleted, ...rest] = record.split('\t');
    if (rest.length === 0) continue;
    counts.set(rest.join('\t'), { added: Number(added) || 0, deleted: Number(deleted) || 0 });
  }
  const files: FileChange[] = [];
  const named = git(cwd, ['diff', '--no-renames', '--name-status', '-z', a, b]).split('\0');
  for (let i = 0; i + 1 < named.length; i += 2) {
    const code = named[i] ?? '';
    const path = named[i + 1] ?? '';
    const c = counts.get(path) ?? { added: 0, deleted: 0 };
    files.push({ path, status: STATUS[code[0] ?? 'M'] ?? 'modified', ...c });
  }
  files.sort((x, y) => x.path.localeCompare(y.path));

  let patch = '';
  let truncated = false;
  if (opts.patch !== false) {
    const max = opts.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
    const full = git(cwd, ['diff', '--no-renames', '--no-color', a, b]);
    const buf = Buffer.from(full);
    truncated = buf.length > max;
    // Cut on a line boundary so the last line shown is a whole line.
    patch = full;
    if (truncated) {
      const cut = buf.subarray(0, max).toString('utf8');
      patch = cut.slice(0, cut.lastIndexOf('\n') + 1);
    }
  }
  return { files, patch, truncated };
}

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
  opts: {
    maxPatchBytes?: number;
    /**
     * Skip the unified diff (the debug bundle wants the diffstat only). Note: with
     * `patch: false` the returned `patch` is '' and `truncated` is false — '' cannot
     * distinguish "no diff" from "patch disabled"; a surface that shows a patch must
     * not call this with patch off.
     */
    patch?: boolean;
  } = {},
): SessionDiff {
  const ref = `refs/heads/${branch}`;
  let from: string;
  try {
    from = git(projectRoot, ['merge-base', 'HEAD', ref]).trim();
  } catch {
    throw new CrossweaveError('DIFF_UNAVAILABLE', `No diff for ${branch}: the branch or the base could not be read.`);
  }
  const { files, patch, truncated } = diffBetween(projectRoot, from, ref, opts);

  let uncommitted: number | null = null;
  if (worktreePath !== null && existsSync(worktreePath)) {
    try {
      uncommitted = git(worktreePath, ['status', '--porcelain']).split('\n').filter((l) => l !== '').length;
    } catch {
      // Unknown is not clean: Land removes the worktree after merging committed changes.
      uncommitted = null;
    }
  }
  return { files, patch, truncated, uncommitted };
}
