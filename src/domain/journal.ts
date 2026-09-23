import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crossweaveDir } from '../core/paths.js';

/**
 * What a client had open, so it can come back after a restart.
 *
 * Written only by the daemon (see the `journal.get`/`journal.set` handlers): the file
 * lives under `.crossweave/`, which the daemon owns, and a remote client arriving
 * over the gateway could not write it at all. Clients ask for it, they do not touch it.
 */
export interface JournalEntry {
  /**
   * Which workspace the entry belongs to. A journal whose id does not match the caller
   * reads as empty rather than restoring another workspace's panes: `workspace.delete`
   * followed by a fresh `workspace.init` on the same root reuses the path, so the file
   * surviving that is expected, and trusting it would open panes for sessions that no
   * longer exist in the workspace being asked about.
   */
  workspaceId: string;
  /** Session ids, most recently focused first. */
  openTabs: string[];
  /**
   * Absolute paths of open file surfaces. Carried but never populated: there is no
   * file-surface feature yet, and an empty array is the honest value until one exists.
   */
  fileSurfaces: string[];
  /** When the entry was last written, or null when nothing has been written yet. */
  at: string | null;
}

/**
 * A tab list is a client-supplied list of ids, so it gets the same treatment as any
 * other external input: length-bounded, deduped, and filtered against reality. 16 is
 * well past the four panes the cockpit shows — the bound is there so a runaway client
 * cannot grow a state file without limit, not to shape the UI.
 */
const MAX_TABS = 16;

export function journalPath(projectRoot: string): string {
  return join(crossweaveDir(projectRoot), 'journal.json');
}

export function emptyJournal(workspaceId: string): JournalEntry {
  return { workspaceId, openTabs: [], fileSurfaces: [], at: null };
}

export function readJournal(projectRoot: string): JournalEntry | undefined {
  const p = journalPath(projectRoot);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as JournalEntry;
  } catch {
    // A torn or hand-edited file must not take the daemon down with it: no journal
    // means nothing to restore, which is the same outcome as a first run.
    return undefined;
  }
}

export function writeJournal(projectRoot: string, entry: JournalEntry): void {
  mkdirSync(crossweaveDir(projectRoot), { recursive: true });
  const path = journalPath(projectRoot);
  // tmp + rename (same directory, so it is one filesystem) rather than a direct write:
  // a crash mid-write would otherwise leave a truncated file, and though readJournal
  // tolerates that, tolerating it should not be the only thing standing between a
  // crash and a journal that silently never restores again.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, path);
}

/**
 * Keeps the first occurrence of each entry, in order.
 *
 * The crash-loop guard: a session id appearing twice — a torn restore, a client that
 * re-reported a stale set — must open ONE pane, not two. Two attaches on one session
 * fight over the same pty, which is exactly the failure a restore path is most likely
 * to produce and least likely to notice.
 */
export function guardRestore(entries: string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const id of entries) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

/** Deduped, existing-only, capped tab ids — the one path any tab list takes to disk or
 * into a pane set. */
export function normalizeTabs(tabs: unknown, isKnown: (id: string) => boolean): string[] {
  const strings = Array.isArray(tabs) ? tabs.filter((t): t is string => typeof t === 'string') : [];
  return guardRestore(strings, new Set<string>()).filter(isKnown).slice(0, MAX_TABS);
}
