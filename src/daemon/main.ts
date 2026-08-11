import { join } from 'node:path';
import { openDatabase } from '../db/open.js';
import { crossweaveDir, findProjectRoot } from '../core/paths.js';
import { createDaemon } from './server.js';
import { buildMethods } from './methods.js';

async function main(): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const dir = crossweaveDir(projectRoot);
  const db = openDatabase(join(dir, 'state.db'));
  const daemon = createDaemon({
    socketPath: join(dir, 'daemon.sock'),
    methods: buildMethods(db, projectRoot, undefined, undefined, { startBackgroundJobs: true }),
  });

  await daemon.listen();
  process.stdout.write(`crossweave daemon listening at ${join(dir, 'daemon.sock')}\n`);

  const shutdown = (): void => {
    void daemon.close().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Last line of defence: an MCP server's own 'error' listener (src/mcp/server.ts) is
// the first line, but any other unexpected error in this process must not take down
// every session's agent process just because one thing went wrong. Log it and keep
// serving — a daemon that's still up for the other N sessions beats one that isn't
// up for any of them.
process.on('uncaughtException', (err) => {
  process.stderr.write(`crossweave: uncaught exception in daemon: ${String(err)}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`crossweave: unhandled rejection in daemon: ${String(reason)}\n`);
});

void main();
