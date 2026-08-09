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
    methods: buildMethods(db, projectRoot),
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

void main();
