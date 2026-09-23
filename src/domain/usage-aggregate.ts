import type { SessionRow } from '../db/repositories/session.js';

export interface UsageSummary {
  date: string;
  agentKind: string;
  sessions: number;
  tokens: number;
  costUsd: number;
}

export type GroupBy = 'day' | 'agent' | 'day+agent';

function dateKey(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return 'unknown';
  }
}

export function aggregateUsage(rows: SessionRow[], opts?: { groupBy?: GroupBy }): UsageSummary[] {
  const groupBy = opts?.groupBy ?? 'day+agent';
  const map = new Map<string, UsageSummary>();

  for (const r of rows) {
    const d = dateKey(r.createdAt);
    const a = r.agentKind || 'unknown';
    let key: string;
    let date: string;
    let agentKind: string;
    if (groupBy === 'day') {
      key = d;
      date = d;
      agentKind = 'all';
    } else if (groupBy === 'agent') {
      key = a;
      date = 'all';
      agentKind = a;
    } else {
      key = `${d}|${a}`;
      date = d;
      agentKind = a;
    }
    const cur = map.get(key);
    if (cur) {
      cur.sessions += 1;
      cur.tokens += r.tokenSpent ?? 0;
      cur.costUsd += r.costSpentUsd ?? 0;
    } else {
      map.set(key, { date, agentKind, sessions: 1, tokens: r.tokenSpent ?? 0, costUsd: r.costSpentUsd ?? 0 });
    }
  }

  // Stable sort: by date then agentKind (with 'all' last for grouped views is natural)
  return [...map.values()].sort((x, y) => (x.date === y.date ? x.agentKind.localeCompare(y.agentKind) : x.date.localeCompare(y.date)));
}
