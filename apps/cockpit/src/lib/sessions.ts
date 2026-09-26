import { tierWithCoverage } from '../../../../src/adapters/coverage.js'
export type ListedSession = {
  id: string
  name: string
  status?: string
  agentKind?: string
  enforcementTier?: string
  costSpentUsd?: number
  tokenSpent?: number
  sandbox?: { confined: boolean; reason?: string }
  worktreePath?: string | null
  /** The agent's last assistant text, when its log is readable (Claude, Codex). */
  latestWords?: string
  /** Base of the session's leased port block while it runs (its dev server's port). */
  portBase?: number
  /** `cw/<name>`, or null for a session in the shared checkout. */
  branch?: string | null
  /** The flags this session was last started with; null when never given. */
  launchArgs?: string[] | null
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
    const agentKind = typeof record.agentKind === 'string' ? record.agentKind : undefined
    const enforcementTier =
      typeof record.enforcementTier === 'string' ? record.enforcementTier : undefined
    const costSpentUsd = typeof record.costSpentUsd === 'number' ? record.costSpentUsd : undefined
    const tokenSpent = typeof record.tokenSpent === 'number' ? record.tokenSpent : undefined
    const hasWorktreePath = 'worktreePath' in record
    const worktreePath = typeof record.worktreePath === 'string' ? record.worktreePath : hasWorktreePath ? null : undefined
    const sandboxRaw = record.sandbox as Record<string, unknown> | undefined
    const sandbox = sandboxRaw && typeof sandboxRaw.confined === 'boolean'
      ? { confined: sandboxRaw.confined, reason: typeof sandboxRaw.reason === 'string' ? sandboxRaw.reason : undefined }
      : undefined
    const row: ListedSession = { id: record.id, name, status, ...(worktreePath !== undefined ? { worktreePath } : {}) }
    if (agentKind) row.agentKind = agentKind
    if (enforcementTier) row.enforcementTier = enforcementTier
    if (costSpentUsd !== undefined) row.costSpentUsd = costSpentUsd
    if (tokenSpent !== undefined) row.tokenSpent = tokenSpent
    if (sandbox !== undefined) row.sandbox = sandbox
    if (typeof record.latestWords === 'string' && record.latestWords !== '') row.latestWords = record.latestWords
    const portBase = (record.leases as { portBase?: unknown } | undefined)?.portBase
    if (typeof portBase === 'number') row.portBase = portBase
    if (typeof record.branch === 'string') row.branch = record.branch
    else if (record.branch === null) row.branch = null
    if (record.launchArgs === null) row.launchArgs = null
    else if (Array.isArray(record.launchArgs) && record.launchArgs.every((a) => typeof a === 'string')) {
      row.launchArgs = record.launchArgs as string[]
    }
    out.push(row)
  }
  return out
}

export function formatSandboxLabel(session: ListedSession): string | undefined {
  if (session.worktreePath === null) return 'no worktree'
  if (session.worktreePath === undefined) return undefined
  if (session.sandbox === undefined) return undefined
  if (session.sandbox.confined) return 'sandbox'
  return `no sandbox (${session.sandbox.reason ?? 'no-provider'})`
}

export function formatRailMeta(session: ListedSession): string | undefined {
  const parts: string[] = []
  if (session.enforcementTier) parts.push(tierWithCoverage(session.enforcementTier))
  if (typeof session.costSpentUsd === 'number') parts.push(`$${session.costSpentUsd.toFixed(2)}`)
  const sbox = formatSandboxLabel(session)
  if (sbox) parts.push(sbox)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * Whether this session currently has an agent process. The rail needs it for two
 * things the pane used to reveal the hard way: a Start button that makes sense only
 * for a session that is not running, and a Stop button for the reverse. Only the
 * daemon's own `running` counts — `waiting` is a running agent mid-turn.
 */
export function isSessionRunning(session: Pick<ListedSession, 'status'>): boolean {
  return session.status === 'running'
}

const LIVE = new Set(['running', 'waiting'])

/**
 * Ids of sessions that were known and not live in `prev` and are live in `next`.
 * Their panes attached to "no agent" and must re-attach — whichever client started
 * them. Only the cockpit's own Start button used to trigger that, so a session
 * started from the CLI kept its "not running" pane until the window was reloaded.
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
 * The rail header's one line of workspace state — the review found a header that said
 * "Cockpit / Agent rail" and nothing about the workspace. Spend is an estimate from
 * the agents' own reports, like the usage table's.
 */
export function workspaceSummary(
  projectRoot: string,
  baseBranch: string | null,
  sessions: readonly ListedSession[],
): { title: string; meta: string } {
  const title = projectRoot.split('/').filter((p) => p !== '').pop() ?? 'crossweave'
  // Waiting for the user is still a live agent.
  const running = sessions.filter((s) => LIVE.has(s.status ?? '')).length
  const spend = sessions.reduce((sum, s) => sum + (s.costSpentUsd ?? 0), 0)
  const parts = [
    baseBranch ?? 'detached HEAD',
    `${running} of ${sessions.length} running`,
    `≈$${spend.toFixed(2)}`,
  ]
  return { title, meta: parts.join(' · ') }
}
