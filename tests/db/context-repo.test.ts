import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { ContextRepo, type ContextEntryRow } from '../../src/db/repositories/context.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let repo: ContextRepo;
let workspaceId: string;
let sessionId: string;

function makeEntry(overrides: Partial<ContextEntryRow> = {}): ContextEntryRow {
  return {
    id: newId('ctx'), workspaceId, sessionId, scope: 'shared', key: 'plan',
    body: 'do the thing', createdAt: '2026-08-10T00:00:00.000Z', ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-context-'));
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
  repo = new ContextRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('ContextRepo', () => {
  it('round-trips an entry, findable by id and by key', () => {
    const row = makeEntry();
    repo.upsert(row);
    expect(repo.findById(row.id)).toEqual(row);
    expect(repo.findByKey(workspaceId, sessionId, 'plan')).toEqual(row);
  });

  it('overwriting the same key keeps the original id', () => {
    const first = makeEntry();
    repo.upsert(first);
    const second = makeEntry({ id: newId('ctx'), body: 'updated plan' });
    repo.upsert(second);

    const found = repo.findByKey(workspaceId, sessionId, 'plan');
    expect(found?.id).toBe(first.id); // NOT second.id
    expect(found?.body).toBe('updated plan');
    expect(repo.findById(first.id)?.body).toBe('updated plan');
  });

  it('rejects a body over 64KB', () => {
    expect(() => repo.upsert(makeEntry({ body: 'x'.repeat(65537) }))).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_TOO_LARGE' }) as unknown as Error,
    );
  });

  it('listShared returns only shared-scope entries', () => {
    repo.upsert(makeEntry({ key: 'shared-one', scope: 'shared' }));
    repo.upsert(makeEntry({ id: newId('ctx'), key: 'private-one', scope: 'private' }));
    const shared = repo.listShared(workspaceId);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.key).toBe('shared-one');
  });
});
