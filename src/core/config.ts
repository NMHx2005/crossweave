import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CrossweaveError } from './errors.js';

export interface CrossweaveConfig {
  ports: { base: number; blockSize: number; named: Record<string, number> };
  disk: { perSessionBytes: number; perWorkspaceBytes: number };
  db: { strategy: 'none' | 'schema' | 'file-copy'; url?: string };
  cacheIsolation: boolean;
  converge: {
    testCommand?: string;
    mergeStrategy: 'merge' | 'squash' | 'rebase';
    trialDebounceMs: number;
    fullIntegrationIntervalMs: number;
    pairwiseSessionThreshold: number;
  };
}

export const DEFAULT_CONFIG: CrossweaveConfig = {
  ports: { base: 43000, blockSize: 10, named: {} },
  // 2 GB per session, 20 GB per workspace. A 2 GB checkout consumed 9.8 GB of
  // worktrees in 20 minutes in the reports this project was designed against, so
  // these are deliberately not generous.
  disk: { perSessionBytes: 2 * 1024 * 1024 * 1024, perWorkspaceBytes: 20 * 1024 * 1024 * 1024 },
  db: { strategy: 'none' },
  cacheIsolation: true,
  converge: {
    mergeStrategy: 'squash',
    trialDebounceMs: 30_000,
    fullIntegrationIntervalMs: 300_000,
    pairwiseSessionThreshold: 8,
  },
};

const STRATEGIES = new Set(['none', 'schema', 'file-copy']);
const STRATEGIES_CONVERGE = new Set(['merge', 'squash', 'rebase']);

/** Anything a shell would refuse to export is not a variable name we can inject. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names a port lease must never be allowed to overwrite.
 *
 * `LeaseManager.acquire` writes every named port straight into the agent's
 * environment, and that environment wins over the client's shell. A `named` entry
 * called `PATH` or `LD_PRELOAD` would therefore replace the agent's toolchain — or
 * its loader — with a port number, from a file that looks like innocuous
 * configuration. The crossweave-owned names are here because a lease that silently
 * shadowed the session identity would make every downstream lookup lie.
 */
const RESERVED_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'CW_SESSION_ID',
  'CW_SESSION_NAME',
  'CW_PORT_BASE',
]);

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
    converge: { ...DEFAULT_CONFIG.converge, ...input.converge },
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
  // Unvalidated, every one of these lands verbatim in the agent's environment.
  if (typeof config.ports.named !== 'object' || config.ports.named === null) {
    invalid(`ports.named must be an object of NAME: offset, got ${String(config.ports.named)}`);
  }
  for (const [name, offset] of Object.entries(config.ports.named)) {
    if (!ENV_NAME.test(name)) {
      invalid(`ports.named key ${JSON.stringify(name)} is not a valid environment variable name`);
    }
    if (RESERVED_ENV_NAMES.has(name)) {
      invalid(`ports.named must not override ${name}`);
    }
    if (!Number.isInteger(offset)) {
      invalid(`ports.named.${name} must be an integer offset, got ${JSON.stringify(offset)}`);
    }
    if (offset < 0 || offset >= config.ports.blockSize) {
      invalid(
        `ports.named.${name} offset ${String(offset)} is outside the block ` +
          `0..${String(config.ports.blockSize - 1)}`,
      );
    }
  }

  if (config.disk.perSessionBytes < 1 || config.disk.perWorkspaceBytes < 1) {
    invalid('disk limits must be positive');
  }
  if (!STRATEGIES.has(config.db.strategy)) {
    invalid(
      `db.strategy must be one of ${[...STRATEGIES].join(', ')}, got ${String(config.db.strategy)}`,
    );
  }

  if (config.converge.testCommand !== undefined && typeof config.converge.testCommand !== 'string') {
    invalid('converge.testCommand must be a string if set');
  }
  if (!STRATEGIES_CONVERGE.has(config.converge.mergeStrategy)) {
    invalid(`converge.mergeStrategy must be one of merge, squash, rebase, got ${String(config.converge.mergeStrategy)}`);
  }
  if (!Number.isInteger(config.converge.trialDebounceMs) || config.converge.trialDebounceMs < 0) {
    invalid('converge.trialDebounceMs must be a non-negative integer');
  }
  if (!Number.isInteger(config.converge.fullIntegrationIntervalMs) || config.converge.fullIntegrationIntervalMs < 0) {
    invalid('converge.fullIntegrationIntervalMs must be a non-negative integer');
  }
  if (!Number.isInteger(config.converge.pairwiseSessionThreshold) || config.converge.pairwiseSessionThreshold < 1) {
    invalid('converge.pairwiseSessionThreshold must be a positive integer');
  }

  return config;
}
