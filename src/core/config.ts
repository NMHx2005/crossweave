import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CrossweaveError } from './errors.js';

export interface CrossweaveConfig {
  ports: { base: number; blockSize: number; named: Record<string, number> };
  disk: { perSessionBytes: number; perWorkspaceBytes: number };
  db: { strategy: 'none' | 'schema' | 'file-copy'; url?: string };
  cacheIsolation: boolean;
}

export const DEFAULT_CONFIG: CrossweaveConfig = {
  ports: { base: 43000, blockSize: 10, named: {} },
  // 2 GB per session, 20 GB per workspace. A 2 GB checkout consumed 9.8 GB of
  // worktrees in 20 minutes in the reports this project was designed against, so
  // these are deliberately not generous.
  disk: { perSessionBytes: 2 * 1024 * 1024 * 1024, perWorkspaceBytes: 20 * 1024 * 1024 * 1024 },
  db: { strategy: 'none' },
  cacheIsolation: true,
};

const STRATEGIES = new Set(['none', 'schema', 'file-copy']);

function invalid(detail: string): never {
  throw new CrossweaveError('CONFIG_INVALID', `crossweave.config.json: ${detail}`);
}

/**
 * Merged one level deep over the defaults, deliberately. A user writing
 * `{"ports": {"base": 50000}}` means "change the base", not "and blow away
 * blockSize and named" — a plain spread would do the latter silently.
 */
export function loadConfig(projectRoot: string): CrossweaveConfig {
  const path = join(projectRoot, 'crossweave.config.json');
  if (!existsSync(path)) return DEFAULT_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    invalid(`could not be parsed: ${(cause as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) invalid('must contain a JSON object');
  const input = raw as Partial<CrossweaveConfig>;

  const config: CrossweaveConfig = {
    ports: { ...DEFAULT_CONFIG.ports, ...input.ports },
    disk: { ...DEFAULT_CONFIG.disk, ...input.disk },
    db: { ...DEFAULT_CONFIG.db, ...input.db },
    cacheIsolation: input.cacheIsolation ?? DEFAULT_CONFIG.cacheIsolation,
  };

  if (!Number.isInteger(config.ports.base) || config.ports.base < 1024) {
    invalid(`ports.base must be an integer >= 1024, got ${String(config.ports.base)}`);
  }
  if (!Number.isInteger(config.ports.blockSize) || config.ports.blockSize < 1) {
    invalid(`ports.blockSize must be a positive integer, got ${String(config.ports.blockSize)}`);
  }
  if (config.ports.base + config.ports.blockSize > 65535) {
    invalid(`ports.base ${config.ports.base} + blockSize ${config.ports.blockSize} exceeds 65535`);
  }
  if (config.disk.perSessionBytes < 1 || config.disk.perWorkspaceBytes < 1) {
    invalid('disk limits must be positive');
  }
  if (!STRATEGIES.has(config.db.strategy)) {
    invalid(
      `db.strategy must be one of ${[...STRATEGIES].join(', ')}, got ${String(config.db.strategy)}`,
    );
  }

  return config;
}
