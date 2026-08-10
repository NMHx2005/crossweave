import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { EventRepo, type EventRow } from '../../src/db/repositories/event.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let events: EventRepo;
let sessionId: string;
let workspaceId: string;

function makeEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: newId('ev'),
    sessionId,
    workspaceId,
    ts: '2026-08-10T00:00:00.000Z',
    kind: 'session.started',
    payload: '{}',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-event-'));
  db = openDatabase(join(dir, 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: join(dir, 'proj'),
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
  sessionId = newId('s');
  new SessionRepo(db).insert({
    id: sessionId, workspaceId, name: 'auth', agentKind: 'claude', adapter: 'claude',
    status: 'idle', worktreePath: null, branch: null,
    createdAt: '2026-08-10T00:00:00.000Z', lastActiveAt: '2026-08-10T00:00:00.000Z',
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  events = new EventRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('EventRepo', () => {
  it('round-trips an event', () => {
    const row = makeEvent();
    events.insert(row);
    expect(events.listBySession(sessionId)).toEqual([row]);
  });

  it('listByWorkspace returns events across sessions in the workspace', () => {
    events.insert(makeEvent());
    events.insert(makeEvent({ id: newId('ev'), kind: 'commit.made', payload: '{"commitHash":"abc"}' }));
    expect(events.listByWorkspace(workspaceId)).toHaveLength(2);
  });

  it('cascades when the session is deleted', () => {
    events.insert(makeEvent());
    new SessionRepo(db).delete(sessionId);
    expect(events.listBySession(sessionId)).toHaveLength(0);
  });
});
