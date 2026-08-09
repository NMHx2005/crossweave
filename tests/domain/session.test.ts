import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { listWorktreePaths } from '../../src/isolation/worktree.js';
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

describe('SessionManager.create', () => {
  it('creates a worktree and records the session as idle', async () => {
    const s = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    expect(s.status).toBe('idle');
    expect(s.branch).toBe('cw/auth');
    expect(s.adapter).toBe('claude');
    expect(s.enforcementTier).toBe('T3');
    expect(s.worktreePath).not.toBeNull();
    expect(existsSync(join(s.worktreePath!, 'README.md'))).toBe(true);
  });

  it('shares the project root when worktree is false', async () => {
    const s = await sessions.create({ workspaceId, name: 'shared', agent: 'claude', worktree: false });
    expect(s.worktreePath).toBe(fx.root);
    expect(s.branch).toBeNull();
  });

  it('rejects a duplicate session name', async () => {
    await sessions.create({ workspaceId, name: 'dup', agent: 'claude', worktree: true });
    await expect(
      sessions.create({ workspaceId, name: 'dup', agent: 'claude', worktree: true }),
    ).rejects.toMatchObject({ code: 'SESSION_NAME_TAKEN' });
  });

  it('rejects an unknown agent before creating a worktree', async () => {
    await expect(
      sessions.create({ workspaceId, name: 'x', agent: 'cursor', worktree: true }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_AGENT' });
    expect(sessions.list(workspaceId)).toHaveLength(0);
  });

  it('leaves no orphan row when worktree creation fails', async () => {
    await sessions.create({ workspaceId, name: 'first', agent: 'claude', worktree: true });
    // cw/second is free, but pre-creating the branch forces BRANCH_EXISTS.
    const { simpleGit } = await import('simple-git');
    await simpleGit(fx.root).raw(['branch', 'cw/second']);
    await expect(
      sessions.create({ workspaceId, name: 'second', agent: 'claude', worktree: true }),
    ).rejects.toMatchObject({ code: 'BRANCH_EXISTS' });
    expect(sessions.list(workspaceId).map((s) => s.name)).toEqual(['first']);
  });
});

describe('SessionManager.resolve and rename', () => {
  it('resolves by name and by id', async () => {
    const s = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    expect(sessions.resolve(workspaceId, 'auth').id).toBe(s.id);
    expect(sessions.resolve(workspaceId, s.id).id).toBe(s.id);
  });

  it('throws SESSION_NOT_FOUND for an unknown handle', () => {
    expect(() => sessions.resolve(workspaceId, 'ghost')).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' }) as unknown as Error,
    );
  });

  it('renames and rejects a name collision', async () => {
    await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: true });
    expect(sessions.rename(workspaceId, b.id, 'c').name).toBe('c');
    expect(() => sessions.rename(workspaceId, 'c', 'a')).toThrowError(
      expect.objectContaining({ code: 'SESSION_NAME_TAKEN' }) as unknown as Error,
    );
  });

  it('lets a session keep the name it already has', async () => {
    await sessions.create({ workspaceId, name: 'same', agent: 'claude', worktree: true });
    expect(sessions.rename(workspaceId, 'same', 'same').name).toBe('same');
  });
});

describe('SessionManager session name validation', () => {
  // Regression: names went straight into `cw/<name>` as a git branch. Git rejected
  // them downstream and its own multi-line stderr reached the terminal as several
  // lines with no CODE: prefix.
  const rejected = ['has space', 'has\ttab', 'has\nnewline', '-leading-dash', '', 'a'.repeat(65), 'sl/ash', 'dot.ted'];
  for (const name of rejected) {
    it(`rejects ${JSON.stringify(name)} before it reaches git`, async () => {
      await expect(
        sessions.create({ workspaceId, name, agent: 'claude', worktree: true }),
      ).rejects.toMatchObject({ code: 'INVALID_SESSION_NAME' });
      expect(sessions.list(workspaceId)).toHaveLength(0);
    });
  }

  it('accepts ordinary names', async () => {
    for (const name of ['auth', 'feature-1', 'API_v2', 'a']) {
      const s = await sessions.create({ workspaceId, name, agent: 'claude', worktree: true });
      expect(s.name).toBe(name);
    }
  });

  it('validates on rename too', async () => {
    await sessions.create({ workspaceId, name: 'ok', agent: 'claude', worktree: true });
    expect(() => sessions.rename(workspaceId, 'ok', 'not ok')).toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION_NAME' }) as unknown as Error,
    );
    expect(sessions.resolve(workspaceId, 'ok').name).toBe('ok');
  });
});

describe('SessionManager.create unwinds a half-created session', () => {
  // The row is the only thing that makes a worktree reachable. Without unwinding, a
  // failed insert strands a full checkout on disk AND leaves the branch, so the same
  // session name can never be created again.
  it('removes the worktree and the branch when the row insert fails', async () => {
    const { simpleGit } = await import('simple-git');
    const original = SessionRepo.prototype.insert;
    SessionRepo.prototype.insert = (): void => {
      throw new Error('simulated insert failure');
    };
    try {
      await expect(
        sessions.create({ workspaceId, name: 'doomed', agent: 'claude', worktree: true }),
      ).rejects.toThrow('simulated insert failure');
    } finally {
      SessionRepo.prototype.insert = original;
    }

    expect(sessions.list(workspaceId)).toHaveLength(0);
    expect(await listWorktreePaths(fx.root)).toHaveLength(0);
    expect((await simpleGit(fx.root).branch()).all).not.toContain('cw/doomed');

    // The real damage was that the name became permanently unusable. Prove it is not.
    const retry = await sessions.create({
      workspaceId, name: 'doomed', agent: 'claude', worktree: true,
    });
    expect(retry.branch).toBe('cw/doomed');
  });
});

describe('SessionManager.kill', () => {
  it('marks the session dead and keeps the worktree by default', async () => {
    const s = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'auth', { removeWorktree: false });
    expect(sessions.resolve(workspaceId, 'auth').status).toBe('dead');
    expect(existsSync(s.worktreePath!)).toBe(true);
  });

  it('removes the worktree when asked', async () => {
    const s = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'auth', { removeWorktree: true });
    expect(existsSync(s.worktreePath!)).toBe(false);
    expect(sessions.resolve(workspaceId, 'auth').worktreePath).toBeNull();
  });

  it('never removes the project root for a shared session', async () => {
    await sessions.create({ workspaceId, name: 'shared', agent: 'claude', worktree: false });
    await sessions.kill(workspaceId, 'shared', { removeWorktree: true });
    expect(existsSync(fx.root)).toBe(true);
  });
});
