import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { findProjectRoot, crossweaveDir, assertContained } from '../../src/core/paths.js';
import { CrossweaveError } from '../../src/core/errors.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cw-paths-'));
  await $`git init -q -b main`.cwd(root).quiet();
  await writeFile(join(root, 'README.md'), '# fixture\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findProjectRoot', () => {
  it('returns the git root from a nested directory', async () => {
    const nested = join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });
    expect(await realpathEq(findProjectRoot(nested), root)).toBe(true);
  });

  it('throws NOT_A_REPO outside any git repository', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'cw-bare-'));
    try {
      expect(() => findProjectRoot(bare)).toThrowError(
        expect.objectContaining({ code: 'NOT_A_REPO' }) as unknown as Error,
      );
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('crossweaveDir', () => {
  it('appends .crossweave to the project root', () => {
    expect(crossweaveDir('/x/y')).toBe(join('/x/y', '.crossweave'));
  });
});

describe('assertContained', () => {
  it('returns the resolved path for a child', async () => {
    const child = join(root, 'src', 'index.ts');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(child, '');
    expect(await realpathEq(assertContained(root, child), child)).toBe(true);
  });

  it('rejects a traversal escape', () => {
    expect(() => assertContained(root, join(root, '..', 'evil.ts'))).toThrowError(
      expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
    );
  });

  it('rejects a symlink pointing outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cw-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'x');
    const link = join(root, 'link.txt');
    await symlink(join(outside, 'secret.txt'), link);
    try {
      expect(() => assertContained(root, link)).toThrowError(
        expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('accepts a path that does not exist yet but sits under the root', () => {
    const future = join(root, 'not-created-yet', 'file.ts');
    expect(assertContained(root, future)).toContain('not-created-yet');
  });
});

async function realpathEq(a: string, b: string): Promise<boolean> {
  const { realpathSync } = await import('node:fs');
  return realpathSync(a) === realpathSync(b);
}

it('CrossweaveError carries a code', () => {
  const e = new CrossweaveError('X', 'msg');
  expect(e.code).toBe('X');
  expect(e.message).toBe('msg');
  expect(e).toBeInstanceOf(Error);
});
