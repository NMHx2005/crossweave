import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { loadConfig } from '../../src/core/config.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

/**
 * The whole chain: a fake `claude` edits a file and goes quiet → the status sweep ends the turn → the checkpoint says the tree
 * changed → the auto-checker starts the TRUSTED command with no `session.check` call. The command fails once the agent's
 * file exists, so a `fail` verdict proves it ran after the edit. Every "nothing ran" test also proves the session reached the
 * end of a turn and that the command does run when asked, or it would pass for the wrong reason.
 */
async function setup(opts: { autoCheck: boolean; trust: boolean }) {
  const fx = await makeGitFixture();
  writeFileSync(join(fx.root, 'crossweave.config.json'), JSON.stringify({ converge: { testCommand: 'test ! -f agent-made.txt' } }));
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  let sweep: (() => Promise<void>) | undefined;
  const methods = buildMethods(db, fx.root, undefined, loadConfig(fx.root), { shell: '/bin/sh', exposeSweep: (s) => { sweep = s; }, autoCheck: () => opts.autoCheck });
  const bin = join(fx.root, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'claude');
  // Turn one: busy ~4 s, the file lands at 3 s, then an idle prompt. It then waits for a line and runs a second turn that edits nothing.
  writeFileSync(fake, [
    '#!/bin/sh',
    'busy() { i=0; while [ $i -lt 8 ]; do printf \'\\x1b[2K\\x1b[1m✢ Crunching…\\x1b[0m (1s · esc to interrupt)\\n\'; if [ "$1" = edit ] && [ $i -eq 6 ]; then echo made > agent-made.txt; fi; sleep 0.5; i=$((i+1)); done; }',
    'busy edit',
    'printf \'\\x1b[2J\\x1b[H> \'',
    'read x',
    'busy talk',
    'printf \'\\x1b[2J\\x1b[H> \'',
    'sleep 60',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  const ctx = { notify: () => undefined, onClose: () => undefined };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<any> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
  if (opts.trust) await call('config.trust');
  const cleanup = async () => {
    for (const row of await call('session.list') as Array<{ name: string }>) await call('session.kill', { idOrName: row.name }).catch(() => undefined);
    db.close();
    await fx.cleanup();
  };
  const listed = async (): Promise<Record<string, any>> => ((await call('session.list')) as Array<Record<string, any>>).find((s) => s.name === 'dev')!;
  const startAgent = async (): Promise<void> => {
    await call('session.new', { name: 'dev' });
    await call('session.start', { idOrName: 'dev' });
    await call('session.attach', { idOrName: 'dev' });
    await call('session.input', { idOrName: 'dev', data: `export PATH="${fx.root}/bin:$PATH"\n` });
    await call('session.input', { idOrName: 'dev', data: 'claude\n' });
  };
  const turnCheckpointed = async (): Promise<boolean> => ((await call('checkpoint.list', { idOrName: 'dev' })).checkpoints as Array<{ kind: string; files: { added: number } }>)
    .some((c) => c.kind === 'turn' && c.files.added === 1);
  return { call, sweep: () => sweep!, cleanup, listed, startAgent, turnCheckpointed };
}

async function until(pred: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('automatic checks', () => {
  test('a turn that changed the tree starts the trusted check by itself, and a turn that changed nothing does not start another', async () => {
    const t = await setup({ autoCheck: true, trust: true });
    try {
      await t.startAgent();
      await until(async () => { await t.sweep()(); return (await t.listed()).check?.state === 'fail'; });
      const first = (await t.listed()).check;
      expect(first.code).not.toBe(0);

      // Turn two edits nothing: the checkpoint dedupes, the session is not owed a run.
      await t.call('session.input', { idOrName: 'dev', data: 'go\n' });
      let sawWorking = false;
      await until(async () => { await t.sweep()(); const a = (await t.listed()).activity; if (a === 'working') sawWorking = true; return sawWorking && a !== 'working'; });
      await pause(1500);
      await t.sweep()();
      expect((await t.listed()).check.at).toBe(first.at);
    } finally { await t.cleanup(); }
  }, 90_000);

  test('with the setting off nothing runs on its own, though the command does run when asked', async () => {
    const t = await setup({ autoCheck: false, trust: true });
    try {
      await t.startAgent();
      await until(async () => { await t.sweep()(); return t.turnCheckpointed(); });
      await pause(1500);
      await t.sweep()();
      expect((await t.listed()).check).toBeUndefined();
      await t.call('session.check', { idOrName: 'dev' }); // the positive control
      await until(async () => (await t.listed()).check?.state === 'fail');
    } finally { await t.cleanup(); }
  }, 60_000);

  test('an untrusted command is never run automatically', async () => {
    const t = await setup({ autoCheck: true, trust: false });
    try {
      await t.startAgent();
      await until(async () => { await t.sweep()(); return t.turnCheckpointed(); });
      await pause(1500);
      await t.sweep()();
      expect((await t.listed()).check).toBeUndefined();
      await expect(t.call('session.check', { idOrName: 'dev' })).rejects.toMatchObject({ code: 'CHECK_UNTRUSTED' });
    } finally { await t.cleanup(); }
  }, 60_000);
});
