import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { crossweaveDir } from '../core/paths.js';

export interface JournalEntry {
  openTabs: string[]; // sessionIds
  fileSurfaces: string[]; // absolute paths
  at: string;
}

export function journalPath(projectRoot: string): string {
  return join(crossweaveDir(projectRoot), 'journal.json');
}

export function readJournal(projectRoot: string): JournalEntry | undefined {
  const p = journalPath(projectRoot);
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, 'utf8')) as JournalEntry; } catch { return undefined; }
}

export function writeJournal(projectRoot: string, entry: JournalEntry): void {
  mkdirSync(crossweaveDir(projectRoot), { recursive: true });
  writeFileSync(journalPath(projectRoot), JSON.stringify(entry, null, 2));
}

export function guardRestore(entries: string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const id of entries) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}
