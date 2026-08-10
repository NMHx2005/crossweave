import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { MessageBus } from '../../src/domain/bus.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let sessions: SessionManager;
let bus: MessageBus;
let workspaceId: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = new WorkspaceManager(db).init(fx.root).id;
  sessions = new SessionManager(db);
  bus = new MessageBus(db, sessions);
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('MessageBus', () => {
  it('send resolves toSession by name and delivers to that session\'s inbox', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });

    bus.send({ workspaceId, fromSession: a.id, toSession: 'b', body: 'hi', trust: 'agent' });

    const inbox = bus.inbox(workspaceId, b.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toBe('hi');
    expect(inbox[0]?.fromSession).toBe(a.id);
  }, 30_000);

  it('send throws SESSION_NOT_FOUND for an unknown name', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    expect(() =>
      bus.send({ workspaceId, fromSession: a.id, toSession: 'ghost', body: 'hi', trust: 'agent' }),
    ).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }) as unknown as Error);
  }, 30_000);

  it('broadcast reaches every other live session, not the sender', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    const c = await sessions.create({ workspaceId, name: 'c', agent: 'claude', worktree: false });

    bus.broadcast({ workspaceId, fromSession: a.id, body: 'build is red', trust: 'agent' });

    expect(bus.inbox(workspaceId, b.id)).toHaveLength(1);
    expect(bus.inbox(workspaceId, c.id)).toHaveLength(1);
    expect(bus.inbox(workspaceId, a.id)).toHaveLength(0); // sender doesn't receive its own broadcast
  }, 30_000);

  it('broadcast does not reach a dead session', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    await sessions.kill(workspaceId, 'b', { removeWorktree: false });

    bus.broadcast({ workspaceId, fromSession: a.id, body: 'hi', trust: 'agent' });

    expect(bus.inbox(workspaceId, b.id)).toHaveLength(0);
  }, 30_000);

  it('handoff carries a contextRef through to the inbox', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });

    bus.handoff({
      workspaceId, fromSession: a.id, toSession: 'b', body: 'take over', trust: 'agent',
      contextRef: 'ctx_abc',
    });

    expect(bus.inbox(workspaceId, b.id)[0]?.contextRef).toBe('ctx_abc');
  }, 30_000);

  it('deliver marks a message delivered, removing it from the inbox', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    bus.send({ workspaceId, fromSession: a.id, toSession: 'b', body: 'hi', trust: 'agent' });

    const [msg] = bus.inbox(workspaceId, b.id);
    if (msg === undefined) throw new Error('expected a message');
    bus.deliver(msg.id);

    expect(bus.inbox(workspaceId, b.id)).toHaveLength(0);
  }, 30_000);
});
