import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { ContextStore } from '../../src/domain/context-store.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let store: ContextStore;
let workspaceId: string;
let sessionId: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-context-store-'));
  db = openDatabase(join(dir, 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: join(dir, 'proj'),
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
  sessionId = newId('s');
  new SessionRepo(db).insert({
    id: sessionId, workspaceId, name: 'a', agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: null, branch: null, createdAt: '2026-08-10T00:00:00.000Z',
    lastActiveAt: '2026-08-10T00:00:00.000Z', tokenBudget: null, tokenSpent: 0,
    enforcementTier: 'T3', pid: null,
  });
  store = new ContextStore(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('ContextStore', () => {
  it('publish makes an entry visible via readShared', () => {
    const entry = store.publish(workspaceId, sessionId, 'plan', 'the plan');
    expect(store.readShared(workspaceId)).toContainEqual(entry);
  });

  it('readById resolves a contextRef issued by publish', () => {
    const entry = store.publish(workspaceId, sessionId, 'plan', 'the plan');
    expect(store.readById(entry.id)?.body).toBe('the plan');
  });

  it('readById returns undefined for an unknown id', () => {
    expect(store.readById('ctx_nope')).toBeUndefined();
  });

  it('republishing the same key keeps the contextRef valid', () => {
    const first = store.publish(workspaceId, sessionId, 'plan', 'v1');
    store.publish(workspaceId, sessionId, 'plan', 'v2');
    expect(store.readById(first.id)?.body).toBe('v2');
  });
});
