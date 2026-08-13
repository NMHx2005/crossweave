import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { MessageRepo, type MessageRow } from '../../src/db/repositories/message.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let messages: MessageRepo;
let workspaceId: string;
let fromId: string;
let toId: string;

function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: newId('msg'),
    workspaceId,
    fromSession: fromId,
    toSession: toId,
    type: 'direct',
    body: 'hello',
    contextRef: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    deliveredAt: null,
    trust: 'agent',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-message-'));
  db = openDatabase(join(dir, 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: join(dir, 'proj'),
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
  const sessions = new SessionRepo(db);
  fromId = newId('s');
  sessions.insert({
    id: fromId, workspaceId, name: 'a', agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: null, branch: null, createdAt: '2026-08-10T00:00:00.000Z',
    lastActiveAt: '2026-08-10T00:00:00.000Z', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
    enforcementTier: 'T3', pid: null,
  });
  toId = newId('s');
  sessions.insert({
    id: toId, workspaceId, name: 'b', agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: null, branch: null, createdAt: '2026-08-10T00:00:00.000Z',
    lastActiveAt: '2026-08-10T00:00:00.000Z', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
    enforcementTier: 'T3', pid: null,
  });
  messages = new MessageRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('MessageRepo', () => {
  it('round-trips a message', () => {
    const row = makeMessage();
    messages.insert(row);
    expect(messages.findById(row.id)).toEqual(row);
  });

  it('rejects a body over 8KB', () => {
    expect(() => messages.insert(makeMessage({ body: 'x'.repeat(8193) }))).toThrowError(
      expect.objectContaining({ code: 'MESSAGE_TOO_LARGE' }) as unknown as Error,
    );
  });

  it('listPending returns only undelivered messages for that recipient', () => {
    messages.insert(makeMessage());
    messages.insert(makeMessage({ id: newId('msg'), toSession: fromId }));
    const delivered = makeMessage({ id: newId('msg') });
    messages.insert(delivered);
    messages.markDelivered(delivered.id);

    expect(messages.listPending(toId)).toHaveLength(1);
  });

  it('markDelivered stamps deliveredAt', () => {
    const row = makeMessage();
    messages.insert(row);
    messages.markDelivered(row.id);
    expect(messages.findById(row.id)?.deliveredAt).not.toBeNull();
  });

  it('cascades when the recipient session is deleted', () => {
    const row = makeMessage();
    messages.insert(row);
    new SessionRepo(db).delete(toId);
    expect(messages.findById(row.id)).toBeUndefined();
  });
});
