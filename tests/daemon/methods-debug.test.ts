import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import type { SpawnOptions } from '../../src/adapters/types.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';
import { claudeProjectDir } from '../../src/domain/agent-logs.js';

/**
 * `session.debug`'s wiring — where the security promise lives: the daemon scrubs the
 * tail, the error lines and the latest words (and the branch/worktree paths) before
 * they leave; `raw` bypasses; the diff files are capped server-side.
 */

let home: string;
let realHome: string | undefined;
let fx: GitFixture;
beforeEach(async () => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'cw-debug-home-'));
  process.env.HOME = home;
  fx = await makeGitFixture();
});
afterEach(async () => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  await fx.cleanup();
});

async function harness() {
  /** The session's fake shell keeps its output callbacks; the test drives the stream. */
  const emit: Array<(chunk: string) => void> = [];
  const factory = (kind: string) => ({
    kind, enforcementTier: 'T3' as const,
    spawn(opts: SpawnOptions) {
      const exits: Array<(c: number) => void> = [];
      return {
        pid: 1,
        onData: (cb: (chunk: string) => void) => { emit.push(cb); return () => undefined; },
        onExit: (cb: (c: number) => void) => { exits.push(cb); },
        write: () => undefined, resize: () => undefined,
        kill: () => { for (const cb of exits) cb(0); },
      };
    },
  });
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  const methods = buildMethods(db, fx.root, factory, DEFAULT_CONFIG);
  const ctx = { notify: () => undefined, onClose: () => undefined };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
  return { db, call, emit };
}

const SECRET = 'sk-proj-0123456789abcdefghij';

describe('session.debug wiring', () => {
  test('error lines from the session stream are scrubbed; raw keeps them', async () => {
    const { db, call, emit } = await harness();
    try {
      await call('session.new', { name: 'dev' });
      await call('session.start', { idOrName: 'dev' });
      for (const cb of emit) cb(`error: build failed (token=${SECRET})\n`);

      const clean = await call('session.debug', { idOrName: 'dev' }) as { errors: Array<{ line: string }> };
      expect(clean.errors).toHaveLength(1);
      expect(clean.errors[0]!.line).toContain('[redacted-api-key]');
      expect(clean.errors[0]!.line).not.toContain(SECRET);

      const raw = await call('session.debug', { idOrName: 'dev', raw: true }) as { errors: Array<{ line: string }> };
      expect(raw.errors[0]!.line).toContain(SECRET);
      await call('session.stop', { idOrName: 'dev' });
    } finally { db.close(); }
  });

  test('the agent log\'s latest words are scrubbed the same way', async () => {
    const { db, call } = await harness();
    try {
      const row = await call('session.new', { name: 'dev' }) as { worktreePath: string };
      // A Claude log in the scratch home, saying a secret.
      const dir = claudeProjectDir(home, row.worktreePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'run.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `key=${SECRET}` }] } }) + '\n');

      const clean = await call('session.debug', { idOrName: 'dev' }) as { latestWords?: string };
      expect(clean.latestWords).toBeDefined();
      expect(clean.latestWords).not.toContain(SECRET);
      expect(clean.latestWords).toContain('redacted');
    } finally { db.close(); }
  });

  test('the diff file list is capped server-side, with the total said', async () => {
    const { db, call } = await harness();
    try {
      const row = await call('session.new', { name: 'dev' }) as { worktreePath: string; branch: string };
      for (let i = 0; i < 60; i++) writeFileSync(join(row.worktreePath, `f${i}.txt`), `change ${i}\n`);
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['add', '.'], { cwd: row.worktreePath });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'sixty'], { cwd: row.worktreePath });

      const out = await call('session.debug', { idOrName: 'dev' }) as { diff: { files: unknown[]; total: number } };
      expect(out.diff.total).toBe(60);
      expect(out.diff.files.length).toBe(50);
    } finally { db.close(); }
  });

  test('error lines survive a kill (debug the dead session), and a rm forgets them', async () => {
    const { db, call, emit } = await harness();
    try {
      await call('session.new', { name: 'dev' });
      await call('session.start', { idOrName: 'dev' });
      for (const cb of emit) cb('error: boom\n');
      expect(((await call('session.debug', { idOrName: 'dev' })) as { errors: unknown[] }).errors).toHaveLength(1);
      await call('session.stop', { idOrName: 'dev' });
      await call('session.kill', { idOrName: 'dev' });
      // The row and its worktree survive a kill: the bundle still says what failed.
      const dead = await call('session.debug', { idOrName: 'dev' }) as { session: { status: string }; errors: unknown[] };
      expect(dead.session.status).toBe('dead');
      expect(dead.errors).toHaveLength(1);
      // The rm deletes the row (nothing answers for it afterwards); its lines are
      // forgotten through the same path (unit-pinned on ErrorLines.forget).
      await call('session.rm', { idOrName: 'dev' });
      await expect(call('session.debug', { idOrName: 'dev' })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    } finally { db.close(); }
  });
});
