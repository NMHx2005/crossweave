import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
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

/** Resolve the deepest existing ancestor through symlinks, then re-append the rest. */
function resolveThroughExisting(candidate: string): string {
  let head = resolve(candidate);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(head.slice(parent.length + 1));
    head = parent;
  }
  const realHead = existsSync(head) ? realpathSync(head) : head;
  return tail.length === 0 ? realHead : join(realHead, ...tail);
}

export function assertContained(root: string, candidate: string): string {
  const realRoot = realpathSync(resolve(root));
  const abs = isAbsolute(candidate) ? candidate : join(realRoot, candidate);
  const resolved = resolveThroughExisting(abs);
  const rel = relative(realRoot, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new CrossweaveError('PATH_ESCAPE', `Path escapes workspace root: ${candidate}`);
  }
  return resolved;
}
