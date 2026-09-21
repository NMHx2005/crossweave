export interface ActivityItem {
  kind: 'blocked' | 'needs_you' | 'landed';
  sessionId: string;
  at: string;
  read: boolean;
}

export class ActivityFeed {
  private items: ActivityItem[] = [];
  push(kind: ActivityItem['kind'], sessionId: string): void {
    this.items.unshift({ kind, sessionId, at: new Date().toISOString(), read: false });
    if (this.items.length > 50) this.items.pop();
  }
  unread(limit = 5): ActivityItem[] {
    return this.items.filter((i) => !i.read).slice(0, limit);
  }
  ack(sessionId: string): void {
    for (const it of this.items) if (it.sessionId === sessionId) it.read = true;
  }
  all(): ActivityItem[] { return [...this.items]; }
}
