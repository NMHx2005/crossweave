import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { MessageBus } from '../../src/domain/bus.js';
import { ContextStore } from '../../src/domain/context-store.js';
import { buildTools } from '../../src/mcp/tools.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let sessions: SessionManager;
let workspaceId: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = new WorkspaceManager(db).init(fx.root).id;
  sessions = new SessionManager(db);
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('buildTools', () => {
  it('exposes exactly the six real tools, never cw_check or cw_declare_contract', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const bus = new MessageBus(db, sessions);
    const store = new ContextStore(db);
    const tools = buildTools(a.id, workspaceId, bus, store);

    expect(tools.map((t) => t.name).sort()).toEqual([
      'cw_broadcast', 'cw_handoff', 'cw_inbox', 'cw_publish_context', 'cw_read_context', 'cw_send',
    ]);
  }, 30_000);

  it('cw_send delivers to the named recipient and cw_inbox on that session sees it', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    const bus = new MessageBus(db, sessions);
    const store = new ContextStore(db);
    const toolsA = buildTools(a.id, workspaceId, bus, store);
    const toolsB = buildTools(b.id, workspaceId, bus, store);

    const send = toolsA.find((t) => t.name === 'cw_send');
    if (send === undefined) throw new Error('expected cw_send');
    await send.handler({ toSession: 'b', body: 'hi' });

    const inbox = toolsB.find((t) => t.name === 'cw_inbox');
    if (inbox === undefined) throw new Error('expected cw_inbox');
    const result = await inbox.handler({});
    const parsed = JSON.parse(result.content[0]?.text ?? '[]') as { body: string; from: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.body).toBe('hi');
  }, 30_000);

  it('cw_inbox acks what it hands back — a second poll does not redeliver it', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    const bus = new MessageBus(db, sessions);
    const store = new ContextStore(db);
    const toolsA = buildTools(a.id, workspaceId, bus, store);
    const toolsB = buildTools(b.id, workspaceId, bus, store);

    const handoff = toolsA.find((t) => t.name === 'cw_handoff');
    const inbox = toolsB.find((t) => t.name === 'cw_inbox');
    if (!handoff || !inbox) throw new Error('expected tools');
    await handoff.handler({ toSession: 'b', body: 'take over' });

    const first = JSON.parse((await inbox.handler({})).content[0]?.text ?? '[]') as unknown[];
    expect(first).toHaveLength(1);
    const second = JSON.parse((await inbox.handler({})).content[0]?.text ?? '[]') as unknown[];
    expect(second).toHaveLength(0);

    // Only what was READ is acked: a message that arrives after the poll is still pending.
    const send = toolsA.find((t) => t.name === 'cw_send');
    if (send === undefined) throw new Error('expected cw_send');
    await send.handler({ toSession: 'b', body: 'and one more' });
    const third = JSON.parse((await inbox.handler({})).content[0]?.text ?? '[]') as { body: string }[];
    expect(third.map((m) => m.body)).toEqual(['and one more']);
  }, 30_000);

  it('cw_handoff carries contextRef through cw_inbox', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: false });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: false });
    const bus = new MessageBus(db, sessions);
    const store = new ContextStore(db);
    const toolsA = buildTools(a.id, workspaceId, bus, store);
    const toolsB = buildTools(b.id, workspaceId, bus, store);

    const publish = toolsA.find((t) => t.name === 'cw_publish_context');
    const handoff = toolsA.find((t) => t.name === 'cw_handoff');
    const inbox = toolsB.find((t) => t.name === 'cw_inbox');
    if (!publish || !handoff || !inbox) throw new Error('expected tools');

    const published = await publish.handler({ key: 'plan', body: 'the plan' });
    const publishedRef = (JSON.parse(published.content[0]?.text ?? '{}') as { id: string }).id;
    await handoff.handler({ toSession: 'b', body: 'take over', contextRef: publishedRef });

    const result = await inbox.handler({});
    const parsed = JSON.parse(result.content[0]?.text ?? '[]') as { contextRef: string | null }[];
    expect(parsed[0]?.contextRef).toBe(publishedRef);
  }, 30_000);
});
