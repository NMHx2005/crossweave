import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';

function recentPath(): string {
  return join(app.getPath('userData'), 'recent.json');
}

function loadRecent(): string[] {
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
  const cur = loadRecent().filter((x) => x !== root);
  cur.unshift(root);
  saveRecent(cur.slice(0, 10));
}

export function clearRecent(): void {
  saveRecent([]);
}

export function buildRecentSubmenu(open: (root: string) => void): Electron.MenuItemConstructorOptions[] {
  const recents = loadRecent();
  if (recents.length === 0) return [{ label: 'No Recent Folders', enabled: false }];
  return recents.map((root) => ({
    label: root,
    click: () => open(root),
  }));
}
