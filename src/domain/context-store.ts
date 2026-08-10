import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { ContextRepo, type ContextEntryRow } from '../db/repositories/context.js';

export class ContextStore {
  private readonly repo: ContextRepo;

  constructor(db: Database) {
    this.repo = new ContextRepo(db);
  }

  /**
   * Publish (or republish) a shared context entry. Republishing the same key keeps
   * its id stable, so a `contextRef` handed to another session in an earlier handoff
   * still resolves to the latest body.
   */
  publish(workspaceId: string, sessionId: string, key: string, body: string): ContextEntryRow {
    const existing = this.repo.findByKey(workspaceId, sessionId, key);
    const row: ContextEntryRow = {
      id: existing?.id ?? newId('ctx'),
      workspaceId,
      sessionId,
      scope: 'shared',
      key,
      body,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.repo.upsert(row);
    return row;
  }

  readShared(workspaceId: string): ContextEntryRow[] {
    return this.repo.listShared(workspaceId);
  }

  readById(id: string): ContextEntryRow | undefined {
    return this.repo.findById(id);
  }
}
