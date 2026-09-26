import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { listWorktreeFiles, readWorktreeFile, writeWorktreeFile } from '../../src/domain/worktree-files.js';
import { mkdtempSync } from 'node:fs';

let wt: string;
beforeEach(() => {
  wt = realpathSync(mkdtempSync(join(tmpdir(), 'cw-wtfiles-')));
  mkdirSync(join(wt, 'src'));
  writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
});
afterEach(() => { rmSync(wt, { recursive: true, force: true }); });

describe('readWorktreeFile', () => {
  it('reads text with its mtime', () => {
    const r = readWorktreeFile(wt, 'src/a.ts');
    expect(r.content).toBe('export const a = 1;\n');
    expect(r.mtimeMs).toBe(statSync(join(wt, 'src', 'a.ts')).mtimeMs);
  });

  it('refuses paths outside the worktree, through .. or a symlink', () => {
    expect(() => readWorktreeFile(wt, '../../etc/passwd')).toThrow(/PATH_ESCAPE|escapes/);
    symlinkSync('/etc', join(wt, 'etc-link'));
    expect(() => readWorktreeFile(wt, 'etc-link/passwd')).toThrow(/PATH_ESCAPE|escapes/);
  });

  it('refuses binary files and very large ones', () => {
    writeFileSync(join(wt, 'bin.dat'), Buffer.from([0x50, 0x00, 0x41]));
    expect(() => readWorktreeFile(wt, 'bin.dat')).toThrow(/binary/i);
    writeFileSync(join(wt, 'big.txt'), 'x'.repeat(3 * 1024 * 1024));
    expect(() => readWorktreeFile(wt, 'big.txt')).toThrow(/too large/i);
  });
});

describe('writeWorktreeFile', () => {
  it('writes when the file is unchanged since it was read', () => {
    const { mtimeMs } = readWorktreeFile(wt, 'src/a.ts');
    const r = writeWorktreeFile(wt, 'src/a.ts', 'export const a = 2;\n', mtimeMs);
    expect(readFileSync(join(wt, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(r.mtimeMs).toBe(statSync(join(wt, 'src', 'a.ts')).mtimeMs);
  });

  // An agent works in this same worktree: an edit it made while the file was open in
  // the cockpit must not be silently overwritten.
  it('refuses to overwrite a file that changed since it was read', () => {
    const { mtimeMs } = readWorktreeFile(wt, 'src/a.ts');
    const later = new Date(mtimeMs + 5000);
    writeFileSync(join(wt, 'src', 'a.ts'), 'agent edit\n');
    utimesSync(join(wt, 'src', 'a.ts'), later, later);
    expect(() => writeWorktreeFile(wt, 'src/a.ts', 'mine\n', mtimeMs)).toThrow(/changed/i);
    expect(readFileSync(join(wt, 'src', 'a.ts'), 'utf8')).toBe('agent edit\n');
  });

  it('creates a new file inside the worktree, and never outside it', () => {
    writeWorktreeFile(wt, 'src/new.ts', 'hi\n');
    expect(readFileSync(join(wt, 'src', 'new.ts'), 'utf8')).toBe('hi\n');
    expect(() => writeWorktreeFile(wt, '../escape.txt', 'no')).toThrow(/PATH_ESCAPE|escapes/);
  });
});

describe('listWorktreeFiles', () => {
  it('lists tracked and untracked files, honouring .gitignore', async () => {
    await $`git init -q`.cwd(wt).quiet();
    writeFileSync(join(wt, '.gitignore'), 'ignored/\n');
    mkdirSync(join(wt, 'ignored'));
    writeFileSync(join(wt, 'ignored', 'x.ts'), '');
    const files = await listWorktreeFiles(wt);
    expect(files).toContain('src/a.ts');
    expect(files).toContain('.gitignore');
    expect(files.some((f) => f.startsWith('ignored/'))).toBe(false);
  });
});
