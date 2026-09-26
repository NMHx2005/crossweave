import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app } from 'electron';

function recentPath(): string {
  return join(app.getPath('userData'), 'recent.json');
}

export function loadRecent(): string[] {
  try {
    const raw = readFileSync(recentPath(), 'utf8');
    const v = JSON.parse(raw) as { recents?: unknown };
    if (Array.isArray(v.recents)) return v.recents.filter((x): x is string => typeof x === 'string');
  } catch {}
  return [];
}

function saveRecent(list: string[]): void {
  try {
    mkdirSync(dirname(recentPath()), { recursive: true });
    writeFileSync(recentPath(), JSON.stringify({ recents: list }, null, 2));
  } catch {}
}

export function pushRecent(root: string): void {
  // Normalised, so `/repo/` and `/repo` (or a `//` from a joined $TMPDIR) are one entry.
  const normal = resolve(root);
  const cur = loadRecent().filter((x) => x !== normal);
  cur.unshift(normal);
  saveRecent(cur.slice(0, 10));
}

export function clearRecent(): void {
  saveRecent([]);
}
