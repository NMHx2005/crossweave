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

/**
 * The rail header's one line of workspace state: its name, the branch sessions land
 * onto, and how many shells are open. Ended sessions are not counted.
 */
export function workspaceSummary(
  projectRoot: string,
  baseBranch: string | null,
  sessions: readonly ListedSession[],
): { title: string; meta: string } {
  const title = projectRoot.split('/').filter((p) => p !== '').pop() ?? 'crossweave'
  const running = sessions.filter((s) => LIVE.has(s.status ?? '')).length
  const open = sessions.filter((s) => s.status !== 'dead' && s.status !== 'landed').length
  return { title, meta: `${baseBranch ?? 'detached HEAD'} · ${running} of ${open} running` }
}
