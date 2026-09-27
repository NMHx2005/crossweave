import { describe, expect, it } from 'bun:test';
import { Hub, type AuditEntry, type DaemonConn, type Peer } from '../../src/remote/hub.js';

class FakeConn implements DaemonConn {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  closed = false;
  private notify: Array<(m: string, p: unknown) => void> = [];
  private closers: Array<() => void> = [];
  constructor(private readonly answer: (method: string, params: Record<string, unknown>) => unknown = () => ({ ok: true })) {}
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const r = this.answer(method, params);
    if (r instanceof Error) throw r;
    return r as T;
  }
  onNotification(cb: (m: string, p: unknown) => void): void { this.notify.push(cb); }
  onClose(cb: () => void): void { this.closers.push(cb); }
  close(): void { this.closed = true; for (const c of this.closers) c(); }
  emit(method: string, params: unknown): void { for (const n of this.notify) n(method, params); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(answer?: (method: string, params: Record<string, unknown>) => unknown) {
  const conns: Array<{ root: string; conn: FakeConn }> = [];
  const audit: AuditEntry[] = [];
  const hub = new Hub({
    connect: async (root) => {
      const conn = new FakeConn(answer);
      conns.push({ root, conn });
      return { conn, workspaceId: `ws-${root}` };
    },
    audit: (e) => audit.push(e),
    changeDelayMs: 5,
  });
  hub.setProjects([{ root: '/repo/a', name: 'a' }, { root: '/repo/b', name: 'b' }]);
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const peer: Peer = { id: 'p1', deviceId: 'd1', deviceName: 'iPhone', send: (method, params) => sent.push({ method, params }) };
  hub.addPeer(peer);
  return { hub, conns, audit, sent, peer };
}

describe('remote hub', () => {
  it('lists the projects open on the Mac', async () => {
    const { hub } = setup();
    expect(await hub.handle('p1', 'projects', {})).toEqual({ projects: [{ root: '/repo/a', name: 'a' }, { root: '/repo/b', name: 'b' }] });
  });

  it('refuses a project the Mac does not have open, and an unknown peer', async () => {
    const { hub, conns } = setup();
    await expect(hub.handle('p1', 'sessions', { project: '/etc' })).rejects.toMatchObject({ code: 'PROJECT_NOT_OPEN' });
    await expect(hub.handle('p1', 'sessions', {})).rejects.toMatchObject({ code: 'PROJECT_NOT_OPEN' });
    await expect(hub.handle('nobody', 'projects', {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(conns).toHaveLength(0);
  });

  it('names the workspace itself and trims the session list to what the page draws', async () => {
    const { hub, conns } = setup((method) => method === 'session.list'
      ? [
        { id: 's_1', name: 'auth', status: 'running', activity: 'asked', rang: true, agent: 'claude', worktreePath: '/secret/path', env: { X: '1' }, cols: 120, rows: 40, usage: { input: 5, output: 7, cacheWrite: 0, cacheRead: 1, folder: true } },
        { id: 's_int', name: 'integration', agentKind: 'integration' },
      ]
      : { ok: true });
    const r = await hub.handle('p1', 'sessions', { project: '/repo/a', workspaceId: 'ws-evil' }) as { sessions: unknown[] };
    expect(conns[0]?.conn.calls).toEqual([{ method: 'session.list', params: { workspaceId: 'ws-/repo/a' } }]);
    expect(r.sessions).toEqual([{ id: 's_1', name: 'auth', status: 'running', activity: 'asked', rang: true, agent: 'claude', cols: 120, rows: 40, usage: { input: 5, output: 7, cacheWrite: 0, cacheRead: 1, folder: true } }]);
  });

  it('opens one connection per project per phone, and reuses it', async () => {
    const { hub, conns } = setup(() => []);
    await hub.handle('p1', 'sessions', { project: '/repo/a' });
    await hub.handle('p1', 'sessions', { project: '/repo/a' });
    await hub.handle('p1', 'sessions', { project: '/repo/b' });
    expect(conns.map((c) => c.root)).toEqual(['/repo/a', '/repo/b']);
  });

  it('forwards output only for the session being watched', async () => {
    const { hub, conns, sent } = setup();
    await hub.handle('p1', 'watch', { project: '/repo/a', session: 's_1' });
    expect(conns[0]?.conn.calls[0]).toEqual({ method: 'session.attach', params: { workspaceId: 'ws-/repo/a', idOrName: 's_1' } });
    const conn = conns[0]?.conn as FakeConn;
    conn.emit('session.data', { sessionId: 's_1', chunk: 'hello' });
    conn.emit('session.data', { sessionId: 's_2', chunk: 'not yours' });
    conn.emit('session.data', { sessionId: 's_1', chunk: { nonce: 'x', ct: 'y', tag: 'z' } });
    expect(sent.filter((s) => s.method === 'output')).toEqual([{ method: 'output', params: { project: '/repo/a', session: 's_1', data: 'hello' } }]);
    await hub.handle('p1', 'unwatch', { project: '/repo/a', session: 's_1' });
    conn.emit('session.data', { sessionId: 's_1', chunk: 'after' });
    expect(sent.filter((s) => s.method === 'output')).toHaveLength(1);
  });

  it('types into a session, bounded, without logging what was typed', async () => {
    const { hub, conns, audit } = setup();
    await hub.handle('p1', 'send', { project: '/repo/a', session: 's_1', data: 'yes\r' });
    expect(conns[0]?.conn.calls).toEqual([{ method: 'session.input', params: { workspaceId: 'ws-/repo/a', idOrName: 's_1', data: 'yes\r' } }]);
    await expect(hub.handle('p1', 'send', { project: '/repo/a', session: 's_1', data: 'x'.repeat(4097) })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(hub.handle('p1', 'send', { project: '/repo/a', session: 's_1', data: '' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(hub.handle('p1', 'send', { project: '/repo/a', session: '../x y', data: 'a' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const typed = audit.filter((a) => a.action === 'type');
    expect(typed).toEqual([{ device: 'iPhone', action: 'type', project: '/repo/a', session: 's_1', bytes: 4 }]);
    expect(JSON.stringify(audit)).not.toContain('yes');
  });

  it('starts a session with a launcher id only — a command line never comes from the phone', async () => {
    const { hub, conns } = setup((method) => (method === 'session.new' ? { id: 's_new' } : { ok: true }));
    const r = await hub.handle('p1', 'create', { project: '/repo/a', name: 'fix', launcher: 'claude', run: 'rm -rf ~', env: { X: '1' } });
    expect(r).toEqual({ id: 's_new' });
    expect(conns[0]?.conn.calls).toEqual([
      { method: 'session.new', params: { workspaceId: 'ws-/repo/a', name: 'fix', worktree: true } },
      { method: 'session.resume', params: { workspaceId: 'ws-/repo/a', idOrName: 's_new', launcher: 'claude' } },
    ]);
    for (const launcher of ['claude; rm -rf ~', 'Claude', 12, '']) {
      await expect(hub.handle('p1', 'create', { project: '/repo/a', name: 'x', launcher })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
  });

  it('reopens a stopped session\'s shell, with a launcher id only', async () => {
    const { hub, conns } = setup();
    await hub.handle('p1', 'start', { project: '/repo/a', session: 's_1' });
    await hub.handle('p1', 'start', { project: '/repo/a', session: 's_1', launcher: 'codex', run: 'x' });
    expect(conns[0]?.conn.calls).toEqual([
      { method: 'session.resume', params: { workspaceId: 'ws-/repo/a', idOrName: 's_1' } },
      { method: 'session.resume', params: { workspaceId: 'ws-/repo/a', idOrName: 's_1', launcher: 'codex' } },
    ]);
    await expect(hub.handle('p1', 'start', { project: '/repo/a', session: 's_1', launcher: 'a b' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('offers only the enabled launchers, as id, label and whether the Mac has it', async () => {
    const { hub } = setup(() => [
      { id: 'claude', label: 'Claude Code', command: 'claude --secret-flag', enabled: true, available: true },
      { id: 'codex', label: 'Codex', command: 'codex', enabled: false, available: true },
    ]);
    expect(await hub.handle('p1', 'launchers', { project: '/repo/a' })).toEqual({ launchers: [{ id: 'claude', label: 'Claude Code', available: true }] });
  });

  it('refuses every method it does not know, daemon ones included', async () => {
    const { hub, conns } = setup();
    for (const m of ['session.kill', 'session.rm', 'land.session', 'workspace.gc', 'session.input', 'session.resize', undefined]) {
      await expect(hub.handle('p1', m, { project: '/repo/a' })).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    }
    expect(conns).toHaveLength(0);
  });

  it('coalesces a burst of changes into one push', async () => {
    const { hub, conns, sent } = setup(() => []);
    await hub.handle('p1', 'sessions', { project: '/repo/a' });
    const conn = conns[0]?.conn as FakeConn;
    for (let i = 0; i < 5; i++) conn.emit('tui.invalidate', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.filter((s) => s.method === 'changed')).toEqual([{ method: 'changed', params: { project: '/repo/a' } }]);
  });

  it('drops a phone\'s connection to a project the Mac closed, and tells the phone', async () => {
    const { hub, conns, sent } = setup(() => []);
    await hub.handle('p1', 'sessions', { project: '/repo/a' });
    hub.setProjects([{ root: '/repo/b', name: 'b' }]);
    await tick();
    expect(conns[0]?.conn.closed).toBe(true);
    expect(sent.at(-1)).toEqual({ method: 'projects', params: { projects: [{ root: '/repo/b', name: 'b' }] } });
    await expect(hub.handle('p1', 'sessions', { project: '/repo/a' })).rejects.toMatchObject({ code: 'PROJECT_NOT_OPEN' });
  });

  it('reconnects after the daemon went away', async () => {
    const { hub, conns } = setup(() => []);
    await hub.handle('p1', 'sessions', { project: '/repo/a' });
    conns[0]?.conn.close();
    await hub.handle('p1', 'sessions', { project: '/repo/a' });
    expect(conns).toHaveLength(2);
  });

  it('says so when the project\'s daemon cannot be reached, then tries again next time', async () => {
    let fail = true;
    const hub = new Hub({ connect: async () => { if (fail) throw new Error('ENOENT /x/.crossweave/daemon.sock'); return { conn: new FakeConn(() => []), workspaceId: 'w' }; } });
    hub.setProjects([{ root: '/repo/a', name: 'a' }]);
    hub.addPeer({ id: 'p', deviceId: 'd', deviceName: 'n', send: () => undefined });
    const err = await hub.handle('p', 'sessions', { project: '/repo/a' }).catch((e: Error) => e) as Error;
    expect(err).toMatchObject({ code: 'DAEMON_UNREACHABLE' });
    expect(String(err.message)).not.toContain('daemon.sock');
    fail = false;
    expect(await hub.handle('p', 'sessions', { project: '/repo/a' })).toEqual({ sessions: [] });
  });

  it('closes a phone\'s connections when it leaves', async () => {
    const { hub, conns } = setup(() => []);
    await hub.handle('p1', 'sessions', { project: '/repo/a' });
    hub.removePeer('p1');
    await tick();
    expect(conns[0]?.conn.closed).toBe(true);
    expect(hub.peerCount()).toBe(0);
  });
});
