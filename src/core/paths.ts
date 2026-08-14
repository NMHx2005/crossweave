import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { CrossweaveError } from './errors.js';

export function findProjectRoot(startDir: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    throw new CrossweaveError('NOT_A_REPO', `Not inside a git repository: ${startDir}`);
  }
}

export function crossweaveDir(projectRoot: string): string {
  return join(projectRoot, '.crossweave');
}

export function globalCrossweaveDir(homeDir: string = homedir()): string {
  return join(homeDir, '.crossweave');
}

const MAX_SYMLINK_HOPS = 32;

/**
 * Canonicalise the deepest ancestor of `p` that `realpathSync` can resolve, keeping
 * the remainder lexical.
 *
 * A symlink target is a raw stored string. It may be absolute and recorded through a
 * non-canonical ancestor — on macOS `/var` is itself a symlink to `/private/var`, and
 * `tmpdir()` lives under it, so `join(root, 'x')` is exactly this shape. Substituting
 * such a target without re-canonicalising leaves the walk's cursor non-canonical, and a
 * legitimate *internal* symlink is then rejected because its resolved path no longer
 * shares the canonical root prefix. `realpathSync` throws for a path that does not
 * exist, which is what walks us up to the resolvable part.
 */
function canonicalExistingPrefix(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return join(head, ...tail);
      tail.unshift(head.slice(parent.length + 1));
      head = parent;
    }
  }
}

/**
 * Resolve `candidate` one component at a time, dereferencing symlinks by hand.
 *
 * Why not walk up until `existsSync` is true and `realpathSync` that ancestor:
 * `existsSync` FOLLOWS symlinks, so it reports false for a symlink whose target
 * does not exist yet. A dangling symlink inside the root then looks like a
 * not-yet-created plain component, survives into the returned path unresolved,
 * and every later write follows it straight out of the root. `lstatSync` sees the
 * link itself, and `readlinkSync` reads its target even when that target is absent.
 */
function resolveNoFollow(realRoot: string, candidate: string): string {
  const parts = relative(realRoot, resolve(candidate))
    .split(sep)
    .filter((p) => p !== '' && p !== '.');

  let current = realRoot;
  let hops = 0;

  for (const part of parts) {
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    let next = join(current, part);
    for (;;) {
      let stat;
      try {
        stat = lstatSync(next);
      } catch {
        break; // Component does not exist at all; the rest stays lexical.
      }
      if (!stat.isSymbolicLink()) break;
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        throw new CrossweaveError('PATH_ESCAPE', `Too many symlinks resolving: ${candidate}`);
      }
      const target = readlinkSync(next);
      next = canonicalExistingPrefix(
        isAbsolute(target) ? target : resolve(dirname(next), target),
      );
    }
    current = next;
  }

  return current;
}

/**
 * Returns the resolved path when it lies STRICTLY inside `root`.
 *
 * The root itself is deliberately rejected: callers use this to decide what is
 * safe to write to or delete, and `removeWorktree(root, root)` must not be a
 * legal call. This is a decision, not an accident — `tests/core/paths.test.ts`
 * pins it.
 */
export function assertContained(root: string, candidate: string): string {
  const realRoot = realpathSync(resolve(root));
  const abs = isAbsolute(candidate) ? candidate : join(realRoot, candidate);
  const resolved = resolveNoFollow(realRoot, abs);
  const rel = relative(realRoot, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new CrossweaveError('PATH_ESCAPE', `Path escapes workspace root: ${candidate}`);
  }
  return resolved;
}
