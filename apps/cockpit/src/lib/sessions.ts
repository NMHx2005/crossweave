import type { SessionUsage, TokenUsage } from './usage'

function tokenUsage(v: unknown): TokenUsage | undefined {
  const r = v as Record<string, unknown> | null
  if (r === null || typeof r !== 'object') return undefined
  const n = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined)
  const [input, output, cacheWrite, cacheRead] = [n(r.input), n(r.output), n(r.cacheWrite), n(r.cacheRead)]
  if (input === undefined || output === undefined || cacheWrite === undefined || cacheRead === undefined) return undefined
  return { input, output, cacheWrite, cacheRead }
}

/** The daemon's usage figures, or undefined when they are not in the expected shape. */
export function parseUsage(v: unknown): SessionUsage | undefined {
  const r = v as { total?: unknown; byModel?: unknown } | null
  const total = tokenUsage(r?.total)
  if (!total || typeof r?.byModel !== 'object' || r.byModel === null) return undefined
  const folder = (v as { folder?: unknown }).folder === true
  const byModel: Record<string, TokenUsage> = {}
  for (const [model, u] of Object.entries(r.byModel as Record<string, unknown>)) {
    const t = tokenUsage(u)
    if (t) byModel[model] = t
  }
  return folder ? { total, byModel, folder } : { total, byModel }
}

/** A session as the rail sees it: a worktree and the user's shell in it. */
export type ListedSession = {
  id: string
  name: string
  status?: string
  worktreePath?: string | null
  /** What an agent last said in this worktree, when its log is readable (Claude, Codex). */
  latestWords?: string
  /** Base of the session's leased port block while it runs (its dev server's port). */
  portBase?: number
  /** `cw/<name>`, or null for a session in the shared checkout. */
  branch?: string | null
  /** The agent CLI found under the session's shell, if any (the daemon infers it). */
  agent?: string | null
  /** What the shell is doing: working / asked / idle / failed. */
  activity?: string
  /** Epoch ms of the last output or input. */
  lastActivityAt?: number | null
  /** Files not yet committed in its folder, and commits not yet landed (null: unknown, e.g. shared). */
  git?: { changed: number; ahead: number | null }
  /** Tokens the agents run in its folder have used since it was created, by model. */
  usage?: SessionUsage
  /** It rang the bell since the user last typed: asking, not just finished. */
  rang?: boolean
  /** The user's one-line note on it, shown in the rail instead of the agent's words. */
  note?: string
}

export function parseSessionList(value: unknown): ListedSession[] {
  if (!Array.isArray(value)) return []
  const out: ListedSession[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : record.id
    const status = typeof record.status === 'string' ? record.status : undefined
    const hasWorktreePath = 'worktreePath' in record
    const worktreePath = typeof record.worktreePath === 'string' ? record.worktreePath : hasWorktreePath ? null : undefined
    const row: ListedSession = { id: record.id, name, status, ...(worktreePath !== undefined ? { worktreePath } : {}) }
    if (typeof record.latestWords === 'string' && record.latestWords !== '') row.latestWords = record.latestWords
    const portBase = (record.leases as { portBase?: unknown } | undefined)?.portBase
    if (typeof portBase === 'number') row.portBase = portBase
    if (typeof record.branch === 'string') row.branch = record.branch
    else if (record.branch === null) row.branch = null
    if (typeof record.agent === 'string') row.agent = record.agent
    else if (record.agent === null) row.agent = null
    if (typeof record.activity === 'string') row.activity = record.activity
    if (typeof record.lastActivityAt === 'number') row.lastActivityAt = record.lastActivityAt
    const git = record.git as { changed?: unknown; ahead?: unknown } | undefined
    if (git !== null && typeof git === 'object' && typeof git.changed === 'number') {
      row.git = { changed: git.changed, ahead: typeof git.ahead === 'number' ? git.ahead : null }
    }
    if (typeof record.rang === 'boolean') row.rang = record.rang
    if (typeof record.note === 'string' && record.note.trim() !== '') row.note = record.note
    const usage = parseUsage(record.usage)
    if (usage) row.usage = usage
    out.push(row)
  }
  return out
}

/** The rail row's second line: where the session works, and its dev port while running. */
export function formatRailMeta(session: ListedSession): string | undefined {
  const parts: string[] = []
  if (session.branch) parts.push(session.branch)
  else if (session.branch === null || session.worktreePath === null) parts.push('shared checkout')
  if (session.portBase !== undefined) parts.push(`port ${session.portBase}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * Whether this session's shell is open. The rail needs it for a Start button that
 * makes sense only for a session that is not running, and a Stop button for the
 * reverse.
 */
export function isSessionRunning(session: Pick<ListedSession, 'status'>): boolean {
  return session.status === 'running'
}

/** A shell is open; `waiting` survives only in rows written by an older version. */
const LIVE = new Set(['running', 'waiting'])

/**
 * Ids of sessions that were known and not live in `prev` and are live in
 * `next`. Their panes attached to "no shell" and must re-attach — whichever client
 * started them; a session started from the CLI otherwise kept its "not running" pane
 * until the window was reloaded.
 */
export function sessionsThatStartedRunning(
  prev: ReadonlyArray<{ id: string; status?: string }>,
  next: ReadonlyArray<{ id: string; status?: string }>,
): string[] {
  const before = new Map(prev.map((s) => [s.id, s.status ?? '']))
  return next
    .filter((s) => before.has(s.id) && !LIVE.has(before.get(s.id)!) && LIVE.has(s.status ?? ''))
    .map((s) => s.id)
}
