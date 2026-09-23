import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

describe('workspace.listFiles', () => {
  it('lists files in projectRoot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-listfiles-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'x');
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'b.txt'), 'y');
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({ id: 'ws1', name: 'w', rootPath: dir, createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2' });
      const methods = buildMethods(db, dir);
      const res = (methods['workspace.listFiles'] as unknown as (p: Record<string, unknown>)=>{files:{name:string,isDirectory:boolean}[]})({ prefix: '' });
      expect(res.files.some(f=>f.name==='a.txt' && !f.isDirectory)).toBe(true);
      expect(res.files.some(f=>f.name==='sub' && f.isDirectory)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects prefix outside root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-listfiles2-'));
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({ id: 'ws1', name: 'w', rootPath: dir, createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2' });
      const methods = buildMethods(db, dir);
      expect(() => (methods['workspace.listFiles'] as unknown as (p: Record<string, unknown>)=>unknown)({ prefix: '../etc' })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
