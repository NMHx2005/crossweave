import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { newId } from '../../core/ids.js';
import { assertContained, crossweaveDir } from '../../core/paths.js';
import type { CrossweaveConfig } from '../../core/config.js';
import { LeaseRepo, type LeaseKind } from '../../db/repositories/lease.js';
import { allocatePortBlock } from './ports.js';

/**
 * Acquires everything a session needs that is NOT its filesystem, and hands it back
 * as the environment its agent is spawned with.
 *
 * Worktrees isolate files. They do not isolate the port a dev server binds, the
 * database it migrates, the docker project it brings up, or the build cache it
 * writes — all of which are shared by default, and all of which two agents will
 * fight over silently.
 */
export class LeaseManager {
  private readonly leases: LeaseRepo;

  constructor(
    db: Database,
    private readonly projectRoot: string,
    private readonly config: CrossweaveConfig,
  ) {
    this.leases = new LeaseRepo(db);
  }

  private record(sessionId: string, kind: LeaseKind, value: string): void {
    this.leases.insert({
      id: newId('lease'),
      sessionId,
      kind,
      value,
      acquiredAt: new Date().toISOString(),
      releasedAt: null,
    });
  }

  async acquire(sessionId: string): Promise<Record<string, string>> {
    const env: Record<string, string> = {};

    const base = await allocatePortBlock(this.leases, this.config);
    this.record(sessionId, 'port', String(base));
    env.CW_PORT_BASE = String(base);
    env.PORT = String(base);
    for (const [name, offset] of Object.entries(this.config.ports.named)) {
      env[name] = String(base + offset);
    }

    // Lowercased: Compose v2 rejects a project name that is not
    // `[a-z0-9][a-z0-9_-]*`, and `newId` uses an uppercase Crockford alphabet — so
    // the raw id produces a name docker refuses outright.
    const project = `cw_${sessionId.toLowerCase()}`;
    this.record(sessionId, 'docker', project);
    env.COMPOSE_PROJECT_NAME = project;

    if (this.config.cacheIsolation) {
      const cache = join(crossweaveDir(this.projectRoot), 'cache', sessionId);
      mkdirSync(cache, { recursive: true });
      this.record(sessionId, 'cache', cache);
      env.XDG_CACHE_HOME = cache;
    }

    const url = this.acquireDatabase(sessionId);
    if (url !== undefined) env.DATABASE_URL = url;

    return env;
  }

  /**
   * `none` is the default because guessing wrong is worse than doing nothing: pointing
   * an agent at a database that does not exist breaks it, and pointing it at the
   * shared one is the problem this whole layer exists to solve.
   */
  private acquireDatabase(sessionId: string): string | undefined {
    if (this.config.db.strategy === 'none') return undefined;

    if (this.config.db.strategy === 'file-copy') {
      const source = this.config.db.url ?? 'app.db';
      const target = join(crossweaveDir(this.projectRoot), 'db', `${sessionId}.db`);
      mkdirSync(join(crossweaveDir(this.projectRoot), 'db'), { recursive: true });
      const from = assertContained(this.projectRoot, source);
      if (existsSync(from)) copyFileSync(from, target);
      this.record(sessionId, 'db', target);
      return target;
    }

    // schema: the session gets its own Postgres schema via the search_path, leaving
    // the connection URL itself untouched.
    const schema = `cw_${sessionId}`;
    this.record(sessionId, 'db', schema);
    const url = this.config.db.url ?? '';
    return url === '' ? undefined : `${url}${url.includes('?') ? '&' : '?'}options=-csearch_path%3D${schema}`;
  }

  release(sessionId: string): void {
    this.leases.release(sessionId);
  }

  /** Nothing a previous daemon held can have survived its death. */
  releaseAll(): void {
    this.leases.releaseAll();
  }
}
