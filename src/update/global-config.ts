import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { globalCrossweaveDir } from '../core/paths.js';

export interface GlobalConfig {
  installedVersion: string | null;
  updateCheck: boolean;
  lastCheckedAt: string | null;
  lastKnownLatest: string | null;
  lastNotifiedVersion: string | null;
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  installedVersion: null,
  updateCheck: true,
  lastCheckedAt: null,
  lastKnownLatest: null,
  lastNotifiedVersion: null,
};

function configPath(homeDir: string | undefined): string {
  return join(globalCrossweaveDir(homeDir), 'config.json');
}

/**
 * A malformed or missing file both fall back to defaults rather than
 * throwing — this is read on every `cw` invocation (indirectly, via the
 * update checker), and a corrupt global config must never take down an
 * unrelated command. Mirrors this project's existing posture on
 * observability-not-safety state (see `notify()`'s own doc comment).
 */
export function loadGlobalConfig(homeDir?: string): GlobalConfig {
  const path = configPath(homeDir);
  if (!existsSync(path)) return DEFAULT_GLOBAL_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { ...DEFAULT_GLOBAL_CONFIG, ...raw };
  } catch {
    return DEFAULT_GLOBAL_CONFIG;
  }
}

export function saveGlobalConfig(cfg: GlobalConfig, homeDir?: string): void {
  const dir = globalCrossweaveDir(homeDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(homeDir), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
