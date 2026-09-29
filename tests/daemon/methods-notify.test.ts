import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { argvAdapter } from '../helpers/argv-adapter.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

const codeOf = async (fn: () => unknown): Promise<string> => { try { await fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };

describe('session.notify', () => {
  test('marks a running session as finished or asking, tells every client, and a keystroke clears it', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const methods = buildMethods(db, fx.root, () => argvAdapter(['sh', '-c', 'sleep 30']));
      const ctx = { notify: () => undefined, onClose: () => undefined };
      await methods['session.new']!({ workspaceId: ws.id, name: 'solo' }, ctx);
      const seen: string[] = [];
      await methods['daemon.subscribe']!({}, { notify: (m: string) => seen.push(m), onClose: () => undefined });
      const listed = async () => ((await methods['session.list']!({ workspaceId: ws.id }, ctx)) as Array<Record<string, any>>)[0]!;

      // Not started: nothing to signal.
      expect(await codeOf(() => methods['session.notify']!({ workspaceId: ws.id, idOrName: 'solo', message: 'x' }, ctx))).toBe('SESSION_NOT_RUNNING');

      await methods['session.start']!({ workspaceId: ws.id, idOrName: 'solo' }, ctx);
      const before = seen.length;
      await methods['session.notify']!({ workspaceId: ws.id, idOrName: 'solo', kind: 'done', message: 'tests written' }, ctx);
      expect(seen.length).toBeGreaterThan(before);
      expect(await listed()).toMatchObject({ activity: 'asked', rang: false, signal: { kind: 'done', message: 'tests written' } });

      await methods['session.notify']!({ workspaceId: ws.id, idOrName: 'solo', kind: 'ask', message: 'which one?' }, ctx);
      expect(await listed()).toMatchObject({ activity: 'asked', rang: true, signal: { kind: 'ask' } });

      await methods['session.input']!({ workspaceId: ws.id, idOrName: 'solo', data: 'a' }, ctx);
      const after = await listed();
      expect(after.signal).toBeUndefined();
      expect(after.rang).toBe(false);

      // Bad input is refused before it touches anything.
      expect(await codeOf(() => methods['session.notify']!({ workspaceId: ws.id, idOrName: 'solo', kind: 'run' }, ctx))).toBe('INVALID_PARAMS');
      expect(await codeOf(() => methods['session.notify']!({ workspaceId: ws.id, idOrName: 'solo', message: 'x'.repeat(300) }, ctx))).toBe('INVALID_PARAMS');
      expect(await codeOf(() => methods['session.notify']!({ workspaceId: ws.id, idOrName: 'nobody' }, ctx))).not.toBe('ok');
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);
});
