import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture } from '../helpers/git-fixture.js';
import { processAncestryFor, processTreeFor } from '../helpers/process-diagnostics.js';

/**
 * The whole chain: a fake `claude` typed into the session's own shell works, writes a file and then sits quietly (as an interactive agent
 * does) → the status sweep sees working → asked → checkpoints appear on their own. The pure pieces are unit-tested; this
 * pins that they are wired to the real status inference.
 */
async function setup() {
  const fx = await makeGitFixture();
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  let sweep: (() => Promise<void>) | undefined;
  const methods = buildMethods(db, fx.root, undefined, DEFAULT_CONFIG, { shell: '/bin/sh', exposeSweep: (s) => { sweep = s; } });
  const bin = join(fx.root, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'claude');
  // Busy for ~4 s (the file lands at 3 s, long after the start checkpoint), then it repaints an idle prompt and sits alive
  // and silent, as an interactive agent does between turns.
  writeFileSync(fake, '#!/bin/sh\ni=0\nwhile [ $i -lt 8 ]; do printf \'\\033[2K\\033[1m✢ Crunching…\\033[0m (1s · esc to interrupt)\\n\'; if [ $i -eq 6 ]; then echo made > agent-made.txt; fi; sleep 0.5; i=$((i+1)); done\nprintf \'\\033[2J\\033[H> \'\nsleep 60\n');
  chmodSync(fake, 0o755);
  const ctx = { notify: () => undefined, onClose: () => undefined };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<any> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
  const cleanup = async () => {
    for (const row of await call('session.list') as Array<{ name: string }>) {
      await call('session.kill', { idOrName: row.name }).catch(() => undefined);
    }
    db.close();
    await fx.cleanup();
  };
  const listed = async (): Promise<Record<string, unknown> | undefined> => ((await call('session.list')) as Array<Record<string, unknown>>).find((s) => s.name === 'dev');
  const diagnostics = async (): Promise<unknown> => ({
    session: await listed(),
    checkpoints: await call('checkpoint.list', { idOrName: 'dev' }),
    processAncestry: processAncestryFor(fake),
    processTree: processTreeFor(Number((await listed())?.pid)),
  });
  return { call, sweep: () => sweep, cleanup, fx, diagnostics };
}

async function until(pred: () => Promise<boolean>, ms = 25_000, diagnostics?: () => Promise<unknown>): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) {
      const state = diagnostics === undefined ? '' : `\nLast state: ${JSON.stringify(await diagnostics(), null, 2)}`;
      throw new Error(`until: timed out${state}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('automatic checkpoints', () => {
  test('an agent starting and finishing a turn is checkpointed with no one asking', async () => {
    const t = await setup();
    const sweep = t.sweep();
    if (sweep === undefined) throw new Error('exposeSweep never ran');
    try {
      await t.call('session.new', { name: 'dev' });
      await t.call('session.start', { idOrName: 'dev' });
      await t.call('session.attach', { idOrName: 'dev' });
      await t.call('session.input', { idOrName: 'dev', data: `export PATH="${t.fx.root}/bin:$PATH"\n` });
      await t.call('session.input', { idOrName: 'dev', data: 'claude\n' });

      const rows = async (): Promise<Array<{ kind: string; files: { added: number } }>> =>
        (await t.call('checkpoint.list', { idOrName: 'dev' })).checkpoints;
      // Newest first. The agent writes its file at ~3 s, so a checkpoint taken after that one holds it and an earlier one
      // does not. (Which of `start`/`turn` the earlier one is depends on whether the busy screen appears before the
      // sweep: both would be the same tree, and the dedupe keeps one.)
      await until(async () => {
        await sweep();
        const list = await rows();
        return list.length >= 2 && list[0]?.kind === 'turn' && list[0].files.added === 1;
      }, 25_000, t.diagnostics);
      const list = await rows();
      expect(list[list.length - 1]?.files.added).toBe(0); // the "before"
      expect(list[0]?.files.added).toBe(1); // what the agent wrote during the turn
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  test('a plain shell that merely prints output gets no automatic checkpoint', async () => {
    const t = await setup();
    const sweep = t.sweep();
    if (sweep === undefined) throw new Error('exposeSweep never ran');
    try {
      await t.call('session.new', { name: 'plain' });
      await t.call('session.start', { idOrName: 'plain' });
      await t.call('session.attach', { idOrName: 'plain' });
      await t.call('session.input', { idOrName: 'plain', data: 'ls -la && echo done > made.txt\n' });
      for (let i = 0; i < 20; i += 1) { await sweep(); await new Promise((r) => setTimeout(r, 100)); }
      expect((await t.call('checkpoint.list', { idOrName: 'plain' })).checkpoints).toEqual([]);
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});
