import type { ListedSession } from './sessions'
import type { AttentionKind } from './attention'

/**
 * What a rail row shows, decided here so the rules are tested rather than buried in
 * JSX. A row reads like Deck's: what is happening (a glyph), what was last said (the
 * title), how long ago, and which agent — in that order of importance.
 */

/** "now", "2m", "3h", "2d": how long ago, in the fewest characters. */
export function relativeTime(at: number | null | undefined, now: number): string | undefined {
  if (at === null || at === undefined) return undefined
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** The row's title: what the agent last said, else the session's name. */
export function rowTitle(session: Pick<ListedSession, 'name' | 'latestWords'>): string {
  return session.latestWords ?? session.name
}

export type RowState = 'working' | 'asked' | 'failed' | 'idle' | 'stopped' | 'ended'

/** The glyph: live activity when the shell is open, else why it is not. */
export function rowState(session: Pick<ListedSession, 'status' | 'activity'>): RowState {
  if (session.status === 'dead' || session.status === 'landed') return 'ended'
  if (session.status !== 'running' && session.status !== 'waiting') {
    return session.activity === 'failed' ? 'failed' : 'stopped'
  }
  if (session.activity === 'working' || session.activity === 'asked' || session.activity === 'failed') return session.activity
  return 'idle'
}

export const ROW_STATE_LABEL: Record<RowState, string> = {
  working: 'working',
  asked: 'waiting for you',
  failed: 'failed',
  idle: 'idle',
  stopped: 'shell closed',
  ended: 'ended',
}

/** The land chip: only the two verdicts worth acting on from the rail. */
export function landChip(attention: AttentionKind | undefined): 'ready' | 'conflict' | undefined {
  return attention === 'ready' || attention === 'conflict' ? attention : undefined
}

const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  cursor: 'Cursor Agent',
}

export function agentName(agent: string | null | undefined): string {
  return agent ? AGENT_NAMES[agent] ?? agent : 'Shell'
}

/** Rows most in need of the user first: asking, failed, working, then the rest. */
export function railOrder(sessions: readonly ListedSession[]): ListedSession[] {
  const rank: Record<RowState, number> = { asked: 0, failed: 1, working: 2, idle: 3, stopped: 4, ended: 5 }
  return [...sessions].sort((a, b) => {
    const r = rank[rowState(a)] - rank[rowState(b)]
    if (r !== 0) return r
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
  })
}
