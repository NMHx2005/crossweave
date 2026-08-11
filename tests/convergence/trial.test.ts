// tests/convergence/trial.test.ts
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMergeTrial, resetIntegration } from '../../src/convergence/trial.js';
import { makeGitFixture, commitFile } from '../helpers/git-fixture.js';
import { $ } from 'bun';

async function checkoutNew(root: string, name: string): Promise<void> {
  await $`git checkout -q -b ${name}`.cwd(root).quiet();
}

describe('runMergeTrial', () => {
  test('two non-conflicting branches merge clean', async () => {
    const fixture = await makeGitFixture();
    try {
      const base = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();
      await checkoutNew(fixture.root, 'cw/a');
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await checkoutNew(fixture.root, 'cw/b');
      await commitFile(fixture.root, 'b.txt', 'b\n', 'add b');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const result = await runMergeTrial(fixture.root, base, ['cw/a', 'cw/b']);
      expect(result.result).toBe('clean');
      expect(result.detail).toBeNull();
      expect(existsSync(join(fixture.root, 'a.txt'))).toBe(true);
      expect(existsSync(join(fixture.root, 'b.txt'))).toBe(true);

      resetIntegration(fixture.root, base);
      expect(existsSync(join(fixture.root, 'a.txt'))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test('two branches editing the same line conflict, and the conflicting file is named', async () => {
    const fixture = await makeGitFixture();
    try {
      await commitFile(fixture.root, 'shared.txt', 'base\n', 'seed shared file');
      const base = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();
      await checkoutNew(fixture.root, 'cw/a');
      await commitFile(fixture.root, 'shared.txt', 'from a\n', 'a edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await checkoutNew(fixture.root, 'cw/b');
      await commitFile(fixture.root, 'shared.txt', 'from b\n', 'b edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const result = await runMergeTrial(fixture.root, base, ['cw/a', 'cw/b']);
      expect(result.result).toBe('conflict');
      expect(result.detail).toContain('shared.txt');

      resetIntegration(fixture.root, base);
      expect(readFileSync(join(fixture.root, 'shared.txt'), 'utf8')).toBe('base\n');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a trial is idempotent: running it twice in a row against the same base produces the same result', async () => {
    const fixture = await makeGitFixture();
    try {
      const base = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();
      await checkoutNew(fixture.root, 'cw/a');
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const first = await runMergeTrial(fixture.root, base, ['cw/a']);
      resetIntegration(fixture.root, base);
      const second = await runMergeTrial(fixture.root, base, ['cw/a']);
      resetIntegration(fixture.root, base);

      expect(first).toEqual(second);
    } finally {
      await fixture.cleanup();
    }
  });

  test('a rejecting commit-msg hook does not cause a false conflict on a clean multi-branch trial', async () => {
    const fixture = await makeGitFixture();
    try {
      const base = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();
      await checkoutNew(fixture.root, 'cw/a');
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await checkoutNew(fixture.root, 'cw/b');
      await commitFile(fixture.root, 'b.txt', 'b\n', 'add b');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      // Installed only now, after the setup commits above — it must reject
      // any commit runMergeTrial itself tries to make, not the fixture setup.
      const hooksDir = join(fixture.root, '.git', 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, 'commit-msg');
      writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
      chmodSync(hookPath, 0o755);

      const result = await runMergeTrial(fixture.root, base, ['cw/a', 'cw/b']);
      expect(result.result).toBe('clean');
      expect(result.detail).toBeNull();
      expect(existsSync(join(fixture.root, 'a.txt'))).toBe(true);
      expect(existsSync(join(fixture.root, 'b.txt'))).toBe(true);

      resetIntegration(fixture.root, base);
    } finally {
      await fixture.cleanup();
    }
  });

  test('a conflict at a non-final branch position is reported and stops the trial', async () => {
    const fixture = await makeGitFixture();
    try {
      await commitFile(fixture.root, 'shared.txt', 'base\n', 'seed shared file');
      const base = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();
      await checkoutNew(fixture.root, 'cw/a');
      await commitFile(fixture.root, 'shared.txt', 'from a\n', 'a edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await checkoutNew(fixture.root, 'cw/b');
      await commitFile(fixture.root, 'shared.txt', 'from b\n', 'b edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await checkoutNew(fixture.root, 'cw/c');
      await commitFile(fixture.root, 'c.txt', 'c\n', 'add c');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const result = await runMergeTrial(fixture.root, base, ['cw/a', 'cw/b', 'cw/c']);
      expect(result.result).toBe('conflict');
      expect(result.detail).toContain('shared.txt');
      expect(existsSync(join(fixture.root, 'c.txt'))).toBe(false);

      resetIntegration(fixture.root, base);
      expect(readFileSync(join(fixture.root, 'shared.txt'), 'utf8')).toBe('base\n');
    } finally {
      await fixture.cleanup();
    }
  });
});
