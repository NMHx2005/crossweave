import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a folder the user asked to open is, before a daemon is started in it: the daemon
 * needs a repository's top level, and used to exit at once anywhere else while the
 * client waited out its timeout ("Daemon did not come up within 10000ms").
 */
export type FolderKind =
  | { kind: 'repo' }
  | { kind: 'inside-repo'; repoRoot: string }
  | { kind: 'plain' }
  | { kind: 'missing' };

export function folderKind(path: string): FolderKind {
  let real: string;
  try {
    if (!statSync(path).isDirectory()) return { kind: 'missing' };
    real = realpathSync(path);
  } catch {
    return { kind: 'missing' };
  }
  let top: string;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: real, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return { kind: 'plain' };
  }
  const topReal = realpathSync(top);
  return topReal === real ? { kind: 'repo' } : { kind: 'inside-repo', repoRoot: topReal };
}

const SKIP = new Set(['node_modules', 'Library', 'Pods', 'build', 'dist', 'target', 'vendor']);

/**
 * The repositories beneath `path` (a folder that holds projects, like `work/Win`), for
 * the user to pick from. Breadth-first and bounded — `maxDepth` levels, `max` results,
 * a cap on folders read — so a home folder cannot stall the window; hidden folders and
 * dependency or build folders are skipped, and a repository is not searched inside.
 */
export function findRepos(path: string, opts: { maxDepth?: number; max?: number; maxVisited?: number } = {}): string[] {
  const maxDepth = opts.maxDepth ?? 3;
  const max = opts.max ?? 50;
  const maxVisited = opts.maxVisited ?? 2000;
  const found: string[] = [];
  let queue: string[] = [path];
  let visited = 0;
  for (let depth = 1; depth <= maxDepth && queue.length > 0 && found.length < max; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let names: string[];
      try {
        names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith('.') || SKIP.has(name)) continue;
        const child = join(dir, name);
        if (++visited > maxVisited) return found.sort((a, b) => a.localeCompare(b));
        try {
          if (!statSync(child).isDirectory()) continue;
        } catch {
          continue;
        }
        if (existsSync(join(child, '.git'))) {
          found.push(child);
          if (found.length >= max) break;
        } else {
          next.push(child);
        }
      }
      if (found.length >= max) break;
    }
    queue = next;
  }
  return found.sort((a, b) => a.localeCompare(b));
}
