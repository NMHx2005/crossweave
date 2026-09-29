import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FILES = ['state.db', 'state.db-wal', 'state.db-shm', 'journal.json'];

/**
 * The project's `.crossweave` directory and its state files, for the user alone. SQLite creates
 * its files under the umask (usually 0644) and only the daemon socket was ever chmod'd, which
 * did not matter until a terminal's saved output began to live in the database. Best effort: a
 * file that is missing, or one this process may not change, is skipped rather than fatal.
 */
export function hardenStateFiles(dir: string): void {
  try {
    if (existsSync(dir)) chmodSync(dir, 0o700);
  } catch {
    // not ours to change
  }
  for (const name of FILES) {
    const path = join(dir, name);
    try {
      if (existsSync(path)) chmodSync(path, 0o600);
    } catch {
      // not ours to change
    }
  }
}
