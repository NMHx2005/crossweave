import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CrossweaveError } from '../core/errors.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

export { SCHEMA_VERSION };

export function openDatabase(dbPath: string): Database {
  // 0700 at the source. The database sits beside the daemon socket and holds every
  // session's state, and `mode` on mkdirSync applies only at CREATION — so whichever
  // caller makes the directory first is the one that decides its permissions. The
  // daemon is currently the only caller, and it re-chmods defensively for the
  // already-exists case; setting the mode here means a future caller that opens the
  // database without starting a daemon cannot silently widen it.
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { create: true });

  // Several processes open this file at once — the daemon starting up, and any CLI
  // invocation racing it. Without busy_timeout SQLite fails a contended lock
  // INSTANTLY with SQLITE_BUSY rather than waiting, and switching to WAL needs an
  // exclusive lock. Two cold starts could therefore both die here, before either one
  // reached its socket bind, leaving the auto-start race with no winner at all.
  db.run('PRAGMA busy_timeout = 5000');
  enableWal(db);
  db.run('PRAGMA foreign_keys = ON');

  migrate(db);
  return db;
}

const WAL_SWITCH_ATTEMPTS = 20;
const WAL_SWITCH_DELAY_MS = 25;

/**
 * Synchronous sleep. `openDatabase` is synchronous and this is the only place in the
 * codebase that waits; `Atomics.wait` is the portable way to do it without pulling in
 * a runtime-specific API.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function journalMode(db: Database): string {
  const row = db.query('PRAGMA journal_mode').get() as { journal_mode: string } | null;
  return row?.journal_mode ?? '';
}

/**
 * Switching to WAL takes an exclusive lock, and SQLite answers SQLITE_BUSY for that
 * particular pragma **without honouring busy_timeout** — measured at a ~4% failure
 * rate under six-way contention even with busy_timeout already set.
 *
 * Reading the mode first means the ordinary case never contends at all: only the
 * process that creates the file has to switch anything, and every later opener sees
 * `wal` and returns immediately. The bounded retry exists purely for the creation
 * race, and converges as soon as any one process wins.
 */
function enableWal(db: Database): void {
  for (let attempt = 0; attempt < WAL_SWITCH_ATTEMPTS; attempt += 1) {
    if (journalMode(db) === 'wal') return;
    try {
      db.run('PRAGMA journal_mode = WAL');
      if (journalMode(db) === 'wal') return;
    } catch {
      // Contended: another process is mid-switch. Wait and re-check.
    }
    sleepSync(WAL_SWITCH_DELAY_MS);
  }
  db.close();
  throw new CrossweaveError(
    'DB_WAL_FAILED',
    `Could not switch the database to WAL mode after ${WAL_SWITCH_ATTEMPTS} attempts`,
  );
}

function readVersion(db: Database): number {
  const hasMeta = db
    .query("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get() as { n: number } | null;
  if (hasMeta === null || hasMeta.n === 0) return 0;
  const row = db.query('SELECT version FROM schema_meta').get() as { version: number } | null;
  return row?.version ?? 0;
}

/**
 * Migrate inside BEGIN IMMEDIATE, reading the current version INSIDE that
 * transaction.
 *
 * busy_timeout alone is not enough. Reading the version first and then migrating is
 * a check-then-act: two processes can both observe version 0 and both replay
 * migration 0, and the loser dies on "table schema_meta already exists" rather than
 * on a lock. BEGIN IMMEDIATE takes the write lock up front, so the second process
 * waits, then re-reads a version that is already current and does nothing.
 */
function migrate(db: Database): void {
  try {
    db.run('BEGIN IMMEDIATE');
    const current = readVersion(db);

    if (current > SCHEMA_VERSION) {
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

    db.run('COMMIT');
  } catch (cause) {
    try {
      db.run('ROLLBACK');
    } catch {
      // BEGIN itself may have failed, leaving nothing to roll back.
    }
    db.close();
    throw cause;
  }
}
