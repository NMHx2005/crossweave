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

/** The row tooltip says whether status was reported or inferred, and when that event arrived. */
export function sessionStatusDetail(
  session: Pick<ListedSession, 'lastActivityAt' | 'signal'>,
  now: number,
): string {
  const signal = session.signal
  const reported = signal !== undefined
  const at = signal?.at ?? session.lastActivityAt
  const age = relativeTime(at, now)
  const source = reported ? 'Status reported by cw notify' : 'Status inferred from terminal activity'
  if (age === undefined) return source
  // The inferred reading has no event time of its own: all that is known is when the terminal last moved.
  const label = reported ? 'updated' : 'last activity'
  return `${source} · ${label} ${age === 'now' ? 'just now' : `${age} ago`}`
}

/** The row's title: what the agent last said, else the session's name. */
/** The user's note when there is one, else what the agent last said, else the name. */
export function rowTitle(session: Pick<ListedSession, 'name' | 'latestWords' | 'note' | 'signal'>): string {
  // What the session said itself (`cw notify`) is more current than what its log last recorded.
  return session.note ?? (session.signal?.message ? session.signal.message : undefined) ?? session.latestWords ?? session.name
}

export type RowState = 'working' | 'done' | 'asked' | 'failed' | 'idle' | 'stopped' | 'ended'

/**
 * The glyph: live activity when the shell is open, else why it is not. The daemon's
 * 'asked' is two things — an agent that asks you something (it rang, or a permission
 * prompt is up: `rang`) and one that simply finished its turn — shown apart: amber for
 * the first, green for the second.
 */
export function rowState(session: Pick<ListedSession, 'status' | 'activity' | 'rang'>): RowState {
  if (session.status === 'dead' || session.status === 'landed') return 'ended'
  if (session.status !== 'running' && session.status !== 'waiting') {
    return session.activity === 'failed' ? 'failed' : 'stopped'
  }
  if (session.activity === 'asked') return session.rang === true ? 'asked' : 'done'
  if (session.activity === 'working' || session.activity === 'failed') return session.activity
  return 'idle'
}

/**
 * The circle drawn beside the name. A finished turn draws none: what says "finished, look at it" is the
 * ✓ that is shown until the session is opened (Sidebar), so once you have looked, nothing is left.
 * Measured before this: the green dot stayed until you typed your next message, long after you had looked.
 */
export function glyphState(state: RowState): RowState {
  return state === 'done' ? 'idle' : state
}

/** What each glyph means, in the row's tooltip and to a screen reader. */
export const ROW_STATE_LABEL: Record<RowState, string> = {
  working: 'agent working',
  done: 'agent finished — your turn',
  asked: 'agent is asking you something',
  failed: 'exited with an error',
  idle: 'shell open, nothing running',
  stopped: 'shell closed',
  ended: 'ended (landed or killed)',
}

/**
 * The tests chip: what the last `Run checks` found, said in words as well as colour. A finished verdict the work
 * has moved past is `stale` and shown dim — never as current.
 */
export function checkChip(check: ListedSession['check']): { label: string; tone: 'running' | 'pass' | 'fail'; stale: boolean; title: string } | undefined {
  if (check === undefined) return undefined
  if (check.state === 'running') return { label: 'tests…', tone: 'running', stale: false, title: 'Running the project\'s tests in this session' }
  const took = check.ms === undefined ? '' : ` in ${(check.ms / 1000).toFixed(1)}s`
  const base = check.state === 'pass' ? `Tests passed${took}` : `Tests failed${check.code === undefined ? '' : ` (exit ${check.code})`}${took}`
  return {
    label: check.state === 'pass' ? '✓ tests' : '✗ tests',
    tone: check.state,
    stale: check.stale,
    title: check.stale ? `${base} — the work has changed since; run the checks again` : base,
  }
}

/**
 * A word before landing a session whose last check did not pass: failed tests that still describe the work, or a run
 * that has not finished. A verdict the work has moved past (stale) and a session never checked say nothing: nagging
 * about what may no longer be true, or about a check nobody asked for, would only teach people to click through.
 */
export function landCheckWarning(name: string, check: ListedSession['check']): { title: string; body: string; confirmLabel: string } | undefined {
  if (check === undefined || check.stale) return undefined
  if (check.state === 'fail') {
    return { title: `Land ${name} with failing tests?`, body: `The last tests run in ${name} failed${check.code === undefined ? '' : ` (exit ${check.code})`}. Run them again, or land anyway.`, confirmLabel: 'Land anyway' }
  }
  if (check.state === 'running') {
    return { title: `Land ${name} while its tests run?`, body: `The tests in ${name} have not finished, so nothing says yet whether this work is fit to land.`, confirmLabel: 'Land anyway' }
  }
  return undefined
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

/** Rows most in need of the user first: asking, failed, finished, working, then the rest. */
export function railOrder(sessions: readonly ListedSession[]): ListedSession[] {
  const rank: Record<RowState, number> = { asked: 0, failed: 1, done: 2, working: 3, idle: 4, stopped: 5, ended: 6 }
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
  prev: ReadonlyArray<Pick<ListedSession, 'id' | 'activity' | 'rang'>>,
  next: readonly ListedSession[],
): ListedSession[] {
  const before = new Map(prev.map((s) => [s.id, s]))
  return next.filter((s) => {
    const was = before.get(s.id)
    // Asking is ringing (a permission prompt, a question); an agent that went quiet
    // after its turn without ringing has finished — newlyFinished's.
    return was !== undefined && s.activity === 'asked' && s.rang === true && !(was.activity === 'asked' && was.rang === true)
  })
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

/**
 * The overlap badge: which other sessions share paths with this one — the passive early
 * warning shown while the work is still cheap to move, before a trial merge can turn it
 * into a conflict. `⇄ name` (or `⇄ name +N`), with the shared paths in the title.
 */
export function overlapBadge(overlaps: ListedSession['overlaps']): { label: string; title: string } | undefined {
  if (overlaps === undefined || overlaps.length === 0) return undefined
  const names = overlaps.map((o) => o.session)
  const label = names.length === 1 ? `⇄ ${names[0]}` : `⇄ ${names[0]} +${names.length - 1}`
  const title = overlaps.map((o) => `${o.session}: ${o.paths.join(', ')}`).join(' · ')
  return { label, title }
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

/**
 * Sessions whose agent just finished: an agent CLI runs under the shell, it was working
 * at the previous list and is idle now — it stopped producing without asking anything.
 * A plain shell is never "finished" (every `ls` would notify); waiting for the user is
 * `newlyAsking`'s; a closed shell is not finished; a session first seen idle is not news.
 */
export function newlyFinished(
  prev: ReadonlyArray<Pick<ListedSession, 'id' | 'activity' | 'status'>>,
  next: readonly ListedSession[],
): ListedSession[] {
  const before = new Map(prev.map((s) => [s.id, s]))
  return next.filter((s) => {
    const was = before.get(s.id)
    const quiet = s.activity === 'idle' || (s.activity === 'asked' && s.rang !== true)
    return was !== undefined && was.activity === 'working' && typeof s.agent === 'string'
      && quiet && (s.status === 'running' || s.status === 'waiting')
  })
}

/**
 * Sessions that just said, with `cw notify`, that they are done: a signal that is new (there was none, or it is a
 * later one). The screen-reading `newlyFinished` cannot see these — a plain shell or an unknown agent has no
 * "working" to finish from — so an explicit word counts on its own. A first sight (a reload) is not news.
 */
export function newlySignalled(
  prev: ReadonlyArray<Pick<ListedSession, 'id' | 'signal'>>,
  next: readonly ListedSession[],
): ListedSession[] {
  const before = new Map(prev.map((s) => [s.id, s]))
  return next.filter((s) => {
    const was = before.get(s.id)
    return was !== undefined && s.signal?.kind === 'done' && (was.signal === undefined || was.signal.at !== s.signal.at)
  })
}

/**
 * What the empty-rail menu offers under Open Recent: recently opened projects not
 * already in the rail, newest first, as many as fit a menu.
 */
export function recentToOffer(recent: readonly string[], open: readonly string[], max = 8): string[] {
  const shown = new Set(open)
  return [...new Set(recent)].filter((root) => !shown.has(root)).slice(0, max)
}


/**
 * Where a submenu opens beside the item that opens it: to its right, top edges level
 * (less the menu's padding), flipped to the left when it would leave the window, and
 * pulled up to stay on screen.
 */
export function submenuPosition(
  item: { left: number; right: number; top: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
  inset = 4,
  margin = 8,
): { left: number; top: number } {
  const right = item.right + inset
  const left = right + size.width <= view.width - margin ? right : Math.max(margin, item.left - inset - size.width)
  const top = Math.max(margin, Math.min(item.top - inset, view.height - margin - size.height))
  return { left, top }
}
