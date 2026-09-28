import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { CrossweaveError } from '../core/errors.js';
import { assertContained } from '../core/paths.js';

/**
 * Files in a session's worktree, for the cockpit's in-app editor. Every path goes
 * through `assertContained` (symlink by symlink), so a path from the UI — or one an
 * agent printed — cannot reach outside the worktree.
 */

/** Past this an editor tab is the wrong tool (and the IPC payload gets silly). */
const MAX_BYTES = 2 * 1024 * 1024;

export function readWorktreeFile(worktree: string, rel: string): { content: string; mtimeMs: number } {
  const path = assertContained(worktree, rel);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new CrossweaveError('FILE_NOT_FOUND', `No such file: ${rel}`);
  }
  const st = statSync(path);
  if (st.size > MAX_BYTES) throw new CrossweaveError('FILE_TOO_LARGE', `${rel} is too large to edit here (${st.size} bytes)`);
  // A NUL byte early on is the usual sign of a binary file; showing it as text would
  // mangle it on the next save.
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(8192, st.size));
    readSync(fd, head, 0, head.length, 0);
    if (head.includes(0)) throw new CrossweaveError('FILE_BINARY', `${rel} looks binary; open it in another editor`);
  } finally {
    closeSync(fd);
  }
  return { content: readFileSync(path, 'utf8'), mtimeMs: st.mtimeMs };
}

/**
 * Write `content`, atomically (temp + rename). With `expectedMtimeMs` — the mtime the
 * editor read — a file that has changed since is refused with FILE_CHANGED: the agent
 * shares this worktree, and its edit must not vanish under a save.
 */
export function writeWorktreeFile(
  worktree: string,
  rel: string,
  content: string,
  expectedMtimeMs?: number,
): { mtimeMs: number } {
  const path = assertContained(worktree, rel);
  if (existsSync(path)) {
    if (!statSync(path).isFile()) throw new CrossweaveError('FILE_NOT_FOUND', `Not a file: ${rel}`);
    if (expectedMtimeMs !== undefined && statSync(path).mtimeMs !== expectedMtimeMs) {
      throw new CrossweaveError('FILE_CHANGED', `${rel} changed since it was opened (another process wrote it); reload before saving`);
    }
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new CrossweaveError('FILE_TOO_LARGE', `${rel} is too large to save from here`);
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  const tmp = `${path}.cw-${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
  return { mtimeMs: statSync(path).mtimeMs };
}

const FOLDER_SKIP = new Set(['node_modules', '.git', '.crossweave']);

/**
 * A plain folder's files (no git to ask, so no .gitignore either): walked breadth-first,
 * skipping hidden folders and node_modules, capped like the git listing.
 */
export function listFolderFiles(root: string, limit = 20_000): Promise<string[]> {
  const out: string[] = [];
  let queue = [''];
  while (queue.length > 0 && out.length < limit) {
    const next: string[] = [];
    for (const rel of queue) {
      let entries: Dirent[];
      try {
        entries = readdirSync(join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.') || FOLDER_SKIP.has(e.name)) continue;
        const path = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) next.push(path);
        else if (e.isFile()) out.push(path);
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    queue = next;
  }
  return Promise.resolve(out);
}

/** Tracked and untracked files, honouring .gitignore; capped for a quick-open list. */
export function listWorktreeFiles(worktree: string, limit = 20_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: worktree, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout) => {
      if (err) {
        reject(new CrossweaveError('FILE_LIST_FAILED', `Could not list files: ${err.message}`));
        return;
      }
      resolve([...new Set(String(stdout).split('\0').filter((f) => f !== ''))].slice(0, limit));
    });
  });
}
