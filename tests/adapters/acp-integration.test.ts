import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { decideBlocked } from '../../src/radar/decision.js';
import { AcpAdapter, type AcpAdapterDeps } from '../../src/adapters/acp.js';
import { CrossweaveError } from '../../src/core/errors.js';

const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-acp-agent.ts', import.meta.url));

function collect(proc: { onData(cb: (c: string) => void): void }): () => string {
  let buf = '';
  proc.onData((c) => { buf += c; });
  return () => buf;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Every other AcpAdapter test injects a hand-written decideBlocked stub — this file is
 * the one place that composes the REAL pieces the way buildMethods actually does in
 * production (src/daemon/methods.ts's cursorDeps), so a bug only visible in that
 * composition (not in any individual piece) has somewhere to be caught.
 */
describe('AcpAdapter composed with the real decideBlocked (not a stub)', () => {
  it('a real seeded workspace/session/file_claim state produces a real reject, through the exact wiring buildMethods uses', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: process.cwd(), createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessionsRepo = new SessionRepo(db);
    sessionsRepo.insert({
      id: 's_1', workspaceId: 'ws_1', name: 's_1', agentKind: 'cursor', adapter: 'cursor',
      status: 'running', worktreePath: process.cwd(), branch: 'cw/s_1', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T1', pid: null,
    });
    sessionsRepo.insert({
      id: 's_2', workspaceId: 'ws_1', name: 's_2', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: process.cwd(), branch: 'cw/s_2', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T2', pid: null,
    });
    new FileClaimRepo(db).upsert({
      id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'x.ts', symbol: null,
      kind: 'file', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });

    const workspaces = new WorkspaceManager(db);
    const sessions = new SessionManager(db);
    const fileClaims = new FileClaimRepo(db);
    // Mirrors buildMethods's cursorDeps construction exactly — see src/daemon/methods.ts.
    const cursorDeps: AcpAdapterDeps = {
      resolveWorkspaceId: (sessionId) => {
        const row = sessionsRepo.findById(sessionId);
        if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
        return row.workspaceId;
      },
      decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
    };

    const adapter = new AcpAdapter(cursorDeps, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/x.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:reject');
    proc.kill();
  });

  it('the same state with a NON-colliding path allows, through the real wiring', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: process.cwd(), createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessionsRepo = new SessionRepo(db);
    sessionsRepo.insert({
      id: 's_1', workspaceId: 'ws_1', name: 's_1', agentKind: 'cursor', adapter: 'cursor',
      status: 'running', worktreePath: process.cwd(), branch: 'cw/s_1', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T1', pid: null,
    });

    const workspaces = new WorkspaceManager(db);
    const sessions = new SessionManager(db);
    const fileClaims = new FileClaimRepo(db);
    const cursorDeps: AcpAdapterDeps = {
      resolveWorkspaceId: (sessionId) => {
        const row = sessionsRepo.findById(sessionId);
        if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
        return row.workspaceId;
      },
      decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
    };

    const adapter = new AcpAdapter(cursorDeps, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__REQUEST_PERMISSION__:${JSON.stringify({ locations: [{ path: `${process.cwd()}/nobody-else-touched-this.ts` }], kind: 'edit' })}`);
    await waitFor(() => read().includes('PERMISSION_RESULT:'));
    expect(read()).toContain('PERMISSION_RESULT:allow');
    proc.kill();
  });
});
