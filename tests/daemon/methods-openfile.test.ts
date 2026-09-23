import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

describe('workspace.openFile', () => {
  it('reads a file inside projectRoot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-openfile-'));
    try {
      writeFileSync(join(dir, 'hello.txt'), 'hi');
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({ id: 'ws1', name: 'w', rootPath: dir, createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2' });
      const methods = buildMethods(db, dir);
      const res = (methods['workspace.openFile'] as unknown as (p: Record<string, unknown>)=>{content:string})({ path: 'hello.txt' });
      expect(res.content).toBe('hi');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects path outside root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-openfile2-'));
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({ id: 'ws1', name: 'w', rootPath: dir, createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2' });
      const methods = buildMethods(db, dir);
      expect(() => (methods['workspace.openFile'] as unknown as (p: Record<string, unknown>)=>unknown)({ path: '../etc/passwd' })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
