import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CrossweaveError } from '../core/errors.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

export { SCHEMA_VERSION };

export function openDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  const hasMeta = db
    .query("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get() as { n: number } | null;

  let current = 0;
  if (hasMeta !== null && hasMeta.n > 0) {
    const row = db.query('SELECT version FROM schema_meta').get() as { version: number } | null;
    current = row?.version ?? 0;
  }

  if (current > SCHEMA_VERSION) {
    db.close();
    throw new CrossweaveError(
      'SCHEMA_TOO_NEW',
      `Database schema v${current} is newer than this build (v${SCHEMA_VERSION}). Upgrade crossweave.`,
    );
  }

  for (const migration of MIGRATIONS.slice(current, SCHEMA_VERSION)) {
    for (const statement of migration) db.run(statement);
  }

  if (current < SCHEMA_VERSION) {
    db.run('DELETE FROM schema_meta');
    db.query('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION);
  }

  return db;
}
