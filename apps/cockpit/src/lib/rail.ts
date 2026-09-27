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
  copilot: 'GitHub Copilot CLI',
  aider: 'Aider',
  amp: 'Amp',
  qwen: 'Qwen Code',
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

/**
 * Sessions that started waiting for the user since the previous list: the moment worth
 * a desktop notification. One that was already asking is not news; one first seen
 * asking (a reload) is not either — only a change seen happen.
 */
export function newlyAsking(
  prev: ReadonlyArray<Pick<ListedSession, 'id' | 'activity'>>,
  next: readonly ListedSession[],
): ListedSession[] {
  const before = new Map(prev.map((s) => [s.id, s.activity]))
  return next.filter((s) => s.activity === 'asked' && before.has(s.id) && before.get(s.id) !== 'asked')
}

/**
 * The rows a project shows: landed sessions never (their worktree is gone), killed
 * ones unless the project hides them, and — with a filter typed — only those whose
 * name, last words, branch or agent contain it.
 */
export function visibleRows(sessions: readonly ListedSession[], opts: { hideEnded?: boolean; query?: string } = {}): ListedSession[] {
  const query = (opts.query ?? '').trim().toLowerCase()
  return sessions.filter((s) => {
    if (s.status === 'landed') return false
    if (opts.hideEnded === true && s.status === 'dead') return false
    if (query === '') return true
    return [s.name, s.latestWords, s.branch, s.agent, s.agent ? agentName(s.agent) : undefined]
      .some((field) => typeof field === 'string' && field.toLowerCase().includes(query))
  })
}

/** The git counts as the row shows them: `3` files changed, `↑2` commits to land. */
export function gitBadge(git: ListedSession['git']): { changed?: string; ahead?: string; title: string } | undefined {
  if (git === undefined) return undefined
  const parts: string[] = []
  const out: { changed?: string; ahead?: string; title: string } = { title: '' }
  if (git.changed > 0) {
    out.changed = String(git.changed)
    parts.push(`${git.changed} uncommitted file${git.changed === 1 ? '' : 's'}`)
  }
  if (git.ahead !== null && git.ahead > 0) {
    out.ahead = `↑${git.ahead}`
    parts.push(`${git.ahead} commit${git.ahead === 1 ? '' : 's'} to land`)
  }
  if (parts.length === 0) return undefined
  out.title = parts.join(' · ')
  return out
}

/**
 * ⌘1…⌘9's targets: the rail's rows top to bottom, across projects, as the rail shows
 * them (collapsing a project only folds it away; its sessions keep their numbers).
 */
export function jumpTargets(
  groups: ReadonlyArray<{ projectRoot: string; sessions: readonly ListedSession[]; hideEnded?: boolean }>,
  query = '',
): Array<{ projectRoot: string; sessionId: string }> {
  return groups.flatMap((g) =>
    railOrder(visibleRows(g.sessions, { hideEnded: g.hideEnded, query })).map((s) => ({ projectRoot: g.projectRoot, sessionId: s.id })))
}

/** Where a menu opened at (x, y) goes so all of it stays inside the window. */
export function clampMenu(x: number, y: number, width: number, height: number, viewW: number, viewH: number, margin = 8): { left: number; top: number } {
  const left = Math.max(margin, Math.min(x, viewW - width - margin))
  const top = Math.max(margin, Math.min(y, viewH - height - margin))
  return { left, top }
}
