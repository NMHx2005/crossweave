import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DaemonClient } from '../../src/client/rpc-client.js';
import { bridgeCall } from '../../src/cli/bridge-call.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

/** What a command prints when it fails: run through the real `fail()` in a child process. */
async function printedError(code: string, message: string): Promise<{ stderr: string; status: number | null }> {
  const script = `
    import { fail } from ${JSON.stringify(join(import.meta.dir, '../../src/cli/context.ts'))};
    import { CrossweaveError } from ${JSON.stringify(join(import.meta.dir, '../../src/core/errors.ts'))};
    fail(new CrossweaveError(${JSON.stringify(code)}, ${JSON.stringify(message)}));
  `;
  const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(proc.stderr).text();
  return { stderr, status: await proc.exited };
}

describe('bridgeCall', () => {
  it('a bridge error prints as exactly one CODE: message line, and exits non-zero', async () => {
    const r = await printedError('BRIDGE_NO_COCKPIT', 'No cockpit is attached to this workspace');
    expect(r.stderr).toBe('BRIDGE_NO_COCKPIT: No cockpit is attached to this workspace\n');
    expect(r.status).toBe(1);
  });

  it('a message with line breaks is collapsed to the one line', async () => {
    const r = await printedError('BRIDGE_HANDLER_FAILED', 'first\nsecond\r\nthird');
    expect(r.stderr).toBe('BRIDGE_HANDLER_FAILED: first second third\n');
  });

  it('reaches a real daemon: no cockpit means BRIDGE_NO_COCKPIT with its code', async () => {
    const fx = await makeGitFixture();
    const db: Database = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    const socketPath = join(fx.root, '.crossweave', 'daemon.sock');
    const daemon: Daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    try {
      const ws = await client.call<{ id: string }>('workspace.init', {});
      await expect(bridgeCall(client, ws.id, 'pane.ping')).rejects.toMatchObject({ code: 'BRIDGE_NO_COCKPIT' });
    } finally {
      client.close();
      await daemon.close();
      db.close();
      await fx.cleanup();
    }
  });
});
