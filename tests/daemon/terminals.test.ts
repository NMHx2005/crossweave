import { describe, it, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { TerminalRegistry } from '../../src/daemon/terminals.js';
import { spawnInPty } from '../../src/adapters/pty.js';
import type { MethodContext } from '../../src/daemon/server.js';
import type { SessionRow } from '../../src/db/repositories/session.js';

const session = (id: string, workspaceId = 'w1'): SessionRow => ({
  id, workspaceId, name: `name-${id}`, agentKind: 'claude', adapter: 'claude', status: 'running',
  worktreePath: tmpdir(), branch: `cw/${id}`, createdAt: 'now', lastActiveAt: 'now',
  tokenBudget: null, tokenSpent: 0, costBudgetUsd: null, costSpentUsd: 0, enforcementTier: 'T2', pid: null, launchArgs: null,
});

/** A real pty running `sh`, so input, output and exit are the genuine article. */
const shell = (s: SessionRow) => spawnInPty(['sh'], { cwd: s.worktreePath!, env: { PS1: '$ ' }, cols: 80, rows: 24 });

function recorder(): MethodContext & { seen: Array<[string, Record<string, unknown>]>; text: () => string } {
  const seen: Array<[string, Record<string, unknown>]> = [];
  return {
    seen,
    notify: (m, p) => { seen.push([m, p as Record<string, unknown>]); },
    onClose: () => undefined,
    text: () => seen.filter(([m]) => m === 'terminal.data').map(([, p]) => String(p.chunk)).join(''),
  };
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('TerminalRegistry', () => {
  it('runs a shell for a session, streams its output, and takes input', async () => {
    const reg = new TerminalRegistry(shell);
    const info = reg.open(session('s1'));
    expect(info).toMatchObject({ sessionId: 's1', sessionName: 'name-s1', workspaceId: 'w1' });
    const ctx = recorder();
    reg.subscribe(info.terminalId, ctx);
    reg.write(info.terminalId, 'echo hi-from-shell\n');
    await until(() => ctx.text().includes('hi-from-shell\r\n'));
    await reg.closeAll();
  });

  it('replays what the shell already printed to a late subscriber', async () => {
    const reg = new TerminalRegistry(shell);
    const { terminalId } = reg.open(session('s1'));
    const early = recorder();
    reg.subscribe(terminalId, early);
    reg.write(terminalId, 'echo before-attach\n');
    await until(() => early.text().includes('before-attach\r\n'));
    const late = recorder();
    reg.subscribe(terminalId, late);
    expect(late.text()).toContain('before-attach');
    await reg.closeAll();
  });

  it('lists terminals per workspace and forgets one whose shell exits, announcing it', async () => {
    const changes: number[] = [];
    const reg = new TerminalRegistry(shell, undefined, () => changes.push(1));
    const a = reg.open(session('s1'));
    reg.open(session('s2', 'w2'));
    expect(reg.list('w1').map((t) => t.terminalId)).toEqual([a.terminalId]);
    const ctx = recorder();
    reg.subscribe(a.terminalId, ctx);
    reg.write(a.terminalId, 'exit 3\n');
    await until(() => ctx.seen.some(([m]) => m === 'terminal.exit'));
    expect(ctx.seen.find(([m]) => m === 'terminal.exit')![1]).toMatchObject({ terminalId: a.terminalId, code: 3 });
    expect(reg.list('w1')).toEqual([]);
    expect(changes.length).toBeGreaterThanOrEqual(3); // two opens, one exit
    await reg.closeAll();
  });

  // A session's worktree is about to go away (kill/rm/land/gc): its shells go first.
  it('closes every terminal of a session, and only those', async () => {
    const reg = new TerminalRegistry(shell);
    const a = reg.open(session('s1'));
    const b = reg.open(session('s1'));
    const c = reg.open(session('s2'));
    await reg.closeForSession('s1');
    expect(reg.list('w1').map((t) => t.terminalId)).toEqual([c.terminalId]);
    expect(() => reg.write(a.terminalId, 'x')).toThrow(/TERMINAL_NOT_FOUND|No such terminal/);
    expect(() => reg.write(b.terminalId, 'x')).toThrow();
    await reg.closeAll();
    expect(reg.list('w1')).toEqual([]);
  });

  it('seals output with the terminal id, and drops a chunk the sealer refuses', async () => {
    const sealedFor: string[] = [];
    const reg = new TerminalRegistry(shell, (chunk, s) => { sealedFor.push(s.id); return chunk.includes('SECRET') ? undefined : `sealed:${chunk}`; });
    const { terminalId } = reg.open(session('s1'));
    const ctx = recorder();
    reg.subscribe(terminalId, ctx);
    // Separate commands: one chunk holding both lines would be dropped whole, and the
    // test would then wait forever for `visible`.
    reg.write(terminalId, 'echo visible\n');
    await until(() => ctx.text().includes('visible\r\n'));
    reg.write(terminalId, 'echo SECRET\n');
    await new Promise((r) => setTimeout(r, 300));
    expect(sealedFor.every((id) => id === terminalId)).toBe(true);
    expect(ctx.seen.filter(([m]) => m === 'terminal.data').every(([, p]) => String(p.chunk).startsWith('sealed:'))).toBe(true);
    expect(ctx.text()).not.toContain('SECRET\r\n');
    await reg.closeAll();
  });

  it('rejects an unknown terminal id', () => {
    const reg = new TerminalRegistry(shell);
    expect(() => reg.subscribe('t_nope', recorder())).toThrow(/No such terminal/);
  });
});
