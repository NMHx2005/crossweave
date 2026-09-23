/** How many items the feed remembers before the oldest falls off. */
const MAX_ITEMS = 50;

/**
 * One thing that happened that a human might need to look at.
 *
 * `session` is deliberately an opaque key rather than a `sessionId`: crossweave's
 * `tui.event` payloads carry the session NAME (see `NotifyEvent` in
 * src/notify/dispatcher.ts), and a feed that renamed it on the way in would have to
 * translate back before it could ack. Whatever the producer supplies is what `ack`
 * matches on.
 *
 * Unread/ack is per-window UI state, not daemon state: a second window looking at the
 * same workspace has its own idea of what it has seen, and a reload legitimately starts
 * from nothing. That is why this class is in-memory and why it is not in the DB.
 */
export type ActivityKind = 'blocked' | 'needs_you' | 'landed' | 'land_failed';

export interface ActivityItem {
  kind: ActivityKind;
  session: string;
  at: string;
  read: boolean;
}

export class ActivityFeed {
  private items: ActivityItem[] = [];

  push(kind: ActivityKind, session: string): void {
    this.items.unshift({ kind, session, at: new Date().toISOString(), read: false });
    if (this.items.length > MAX_ITEMS) this.items.pop();
  }

  unread(limit = 5): ActivityItem[] {
    return this.items.filter((i) => !i.read).slice(0, limit);
  }

  ack(session: string): void {
    for (const it of this.items) if (it.session === session) it.read = true;
  }

  all(): ActivityItem[] {
    return [...this.items];
  }
}

/**
 * The one parser for the payloads that feed this list.
 *
 * These are `tui.event` payloads — `NotifyEvent` from src/notify/dispatcher.ts, the same
 * objects the desktop notification and the TUI's own feed line are formatted from. The
 * cockpit already parses that shape once for the rail badge
 * (`blockedSessionFromEvent`); this is a second consumer of the same shape, not a second
 * shape.
 *
 * `collision` and `convergence` name TWO sessions and describe a pair, so they are
 * deliberately not items: an item is something ONE session needs a human for, and the
 * rail badge already carries the collision state. `needs_you` has no producer until
 * something writes `waiting` (see src/db/repositories/session.ts) — the kind exists, and
 * nothing in the UI presents an event as producing it.
 */
export function activityFromEvent(payload: unknown): { kind: ActivityKind; session: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as { kind?: unknown; session?: unknown; ok?: unknown };
  if (typeof record.session !== 'string' || record.session === '') return null;
  if (record.kind === 'blocked') return { kind: 'blocked', session: record.session };
  if (record.kind === 'land') {
    return { kind: record.ok === false ? 'land_failed' : 'landed', session: record.session };
  }
  return null;
}
