import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { EventRepo, type EventRow } from '../db/repositories/event.js';

/**
 * Records session lifecycle events (created, started, landed) in the event table.
 * It used to answer `cw blame` from these too; that went with the collision guard.
 */
export class EventLedger {
  private readonly events: EventRepo;

  constructor(db: Database) {
    this.events = new EventRepo(db);
  }

  append(row: Omit<EventRow, 'id' | 'ts'>): void {
    this.events.insert({ ...row, id: newId('ev'), ts: new Date().toISOString() });
  }
}
