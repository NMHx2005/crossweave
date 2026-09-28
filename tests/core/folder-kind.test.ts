import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRepos, folderKind } from '../../src/core/folder-kind.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'cw-folder-kind-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const repo = (path: string): string => {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: path });
  return path;
};

describe('folderKind', () => {
  it('knows a repository at its top level', () => {
    expect(folderKind(repo(join(root, 'app')))).toEqual({ kind: 'repo' });
  });

  it('points a subfolder of a repository to its root', () => {
    const app = repo(join(root, 'app'));
    mkdirSync(join(app, 'src'));
    expect(folderKind(join(app, 'src'))).toEqual({ kind: 'inside-repo', repoRoot: app });
  });

  it('calls a folder without git plain, and a missing path or a file missing', () => {
    expect(folderKind(root)).toEqual({ kind: 'plain' });
    expect(folderKind(join(root, 'nope'))).toEqual({ kind: 'missing' });
    writeFileSync(join(root, 'f.txt'), 'x');
    expect(folderKind(join(root, 'f.txt'))).toEqual({ kind: 'missing' });
  });
});

describe('findRepos', () => {
  it('finds repositories beneath, sorted, without descending into one', () => {
    const a = repo(join(root, 'Client', 'shop'));
    const b = repo(join(root, 'tools'));
    repo(join(b, 'vendor', 'inner'));
    mkdirSync(join(root, 'empty'));
    expect(findRepos(root)).toEqual([a, b]);
  });

  it('skips hidden folders and node_modules, and stops at the depth given', () => {
    repo(join(root, '.cache', 'x'));
    repo(join(root, 'node_modules', 'pkg'));
    const deep = repo(join(root, 'a', 'b', 'c', 'd'));
    expect(findRepos(root, { maxDepth: 3 })).toEqual([]);
    expect(findRepos(root, { maxDepth: 4 })).toEqual([deep]);
  });

  it('stops at the most it may return, and on a missing folder returns nothing', () => {
    for (let i = 0; i < 5; i++) repo(join(root, `r${i}`));
    expect(findRepos(root, { max: 3 })).toHaveLength(3);
    expect(findRepos(join(root, 'nope'))).toEqual([]);
  });

  it('counts a worktree or submodule (a .git file) as a repository', () => {
    mkdirSync(join(root, 'wt'));
    writeFileSync(join(root, 'wt', '.git'), 'gitdir: /elsewhere\n');
    expect(findRepos(root)).toEqual([join(root, 'wt')]);
  });
});
