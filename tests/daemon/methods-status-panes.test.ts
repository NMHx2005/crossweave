import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

/**
 * The wiring the original bug hid behind: a session's own pty was tracked, its split
 * panes were not. This is the whole chain at once — pane shell → TerminalObserver →
 * ActivityTracker → `ps` sweep → session.list — driven by a fake `claude` binary typed
 * into the pane, because the bug was never in the tracker alone.
 */
async function setup() {
  const fx = await makeGitFixture();
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  let sweep: (() => Promise<void>) | undefined;
  const methods = buildMethods(db, fx.root, undefined, DEFAULT_CONFIG, {
    shell: '/bin/sh',
    exposeSweep: (s) => { sweep = s; },
  });
  const bin = join(fx.root, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'claude');
  // Says the words the screen reader looks for, and keeps saying them: an agent that
  // sits quietly after one line is judged by output alone, and the sweep may lag it.
  // 60 half-second lines keep it alive through the test and quick to die after.
  writeFileSync(fake, '#!/bin/sh\ni=0\nwhile [ $i -lt 60 ]; do printf \'\\x1b[2K\\x1b[1m✢ Crunching…\\x1b[0m (1s · esc to interrupt)\\n\'; sleep 0.5; i=$((i+1)); done\n');
  chmodSync(fake, 0o755);
  const seen: Array<[string, Record<string, unknown>]> = [];
  const ctx = { notify: (m: string, p: unknown) => { seen.push([m, p as Record<string, unknown>]); }, onClose: () => undefined };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
  const cleanup = async () => {
    for (const term of await call('terminal.list') as Array<{ terminalId: string }>) {
      await call('terminal.close', { terminalId: term.terminalId }).catch(() => undefined);
    }
    db.close();
    await fx.cleanup();
  };
  return { call, sweep, cleanup, fake, fx };
}

async function until(pred: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('session status across panes (methods level)', () => {
  test('an agent typed into a split pane moves the session row', async () => {
    const t = await setup();
    if (t.sweep === undefined) throw new Error('exposeSweep never ran');
    try {
      await t.call('session.new', { name: 'dev', agent: 'claude' }) as { worktreePath: string };
      const opened = await t.call('terminal.open', { idOrName: 'dev' }) as { terminalId: string };
      await t.call('terminal.attach', { terminalId: opened.terminalId });
      await t.call('terminal.input', { terminalId: opened.terminalId, data: `export PATH="${t.fx.root}/bin:$PATH"\n` });
      await t.call('terminal.input', { terminalId: opened.terminalId, data: 'claude\n' });

      await until(async () => {
        await t.sweep!();
        const list = await t.call('session.list') as Array<{ name: string; activity: string; agent: string | null }>;
        const row = list.find((s) => s.name === 'dev');        // The pane's shell pid joined the sweep: the row knows WHICH agent runs there.
        return row?.activity === 'working' && row?.agent === 'claude';
      });
      const row = (await t.call('session.list') as Array<{ name: string; activity: string; agent: string | null }>).find((s) => s.name === 'dev');      // The pane's shell pid joined the sweep: the row knows WHICH agent runs there.
      expect(row?.agent).toBe('claude');
    } finally {
      await t.cleanup();
    }
  }, 30_000);
});
