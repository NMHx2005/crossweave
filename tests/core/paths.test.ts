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

  // Regression: `existsSync` follows symlinks and reports false for a dangling one,
  // so an earlier implementation skipped the link entirely and let writes escape.
  it('rejects a DANGLING symlink whose target is outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cw-outside-'));
    const link = join(root, 'dangling.txt');
    await symlink(join(outside, 'not-created-yet.txt'), link);
    try {
      expect(() => assertContained(root, link)).toThrowError(
        expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a path under a DANGLING directory symlink pointing outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cw-outside-'));
    const link = join(root, 'dangling-dir');
    await symlink(join(outside, 'no-such-dir'), link);
    try {
      expect(() => assertContained(root, join(link, 'file.ts'))).toThrowError(
        expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlink loop instead of hanging', async () => {
    await symlink(join(root, 'loop-b'), join(root, 'loop-a'));
    await symlink(join(root, 'loop-a'), join(root, 'loop-b'));
    expect(() => assertContained(root, join(root, 'loop-a'))).toThrowError(
      expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
    );
  });

  it('rejects the root itself, so it can gate deletes', () => {
    expect(() => assertContained(root, root)).toThrowError(
      expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
    );
  });

  // Regression: hand-dereferencing a symlink must re-canonicalise the target.
  // `root` here comes from mkdtemp(tmpdir()) and is NOT realpath'd, so on macOS it
  // reads /var/folders/... while its canonical form is /private/var/folders/... .
  // A link storing that raw absolute target used to resolve to a path that no longer
  // shared the canonical root prefix, and a legitimate internal link was rejected.
  it('accepts an internal symlink whose target is absolute but not canonical', async () => {
    const realTarget = join(root, 'real-target');
    await mkdir(realTarget, { recursive: true });
    await symlink(realTarget, join(root, 'internal-link'));
    const resolved = assertContained(root, join(root, 'internal-link', 'file.ts'));
    expect(resolved.endsWith(join('real-target', 'file.ts'))).toBe(true);
  });

  it('accepts an internal symlink with a relative target', async () => {
    await mkdir(join(root, 'rel-target'), { recursive: true });
    await symlink('rel-target', join(root, 'rel-link'));
    const resolved = assertContained(root, join(root, 'rel-link', 'file.ts'));
    expect(resolved.endsWith(join('rel-target', 'file.ts'))).toBe(true);
  });

  it('rejects a multi-hop symlink chain that ultimately lands outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cw-outside-'));
    await writeFile(join(outside, 'real.txt'), 'x');
    await symlink(join(outside, 'real.txt'), join(root, 'hop3'));
    await symlink(join(root, 'hop3'), join(root, 'hop2'));
    await symlink(join(root, 'hop2'), join(root, 'hop1'));
    try {
      expect(() => assertContained(root, join(root, 'hop1'))).toThrowError(
        expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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
