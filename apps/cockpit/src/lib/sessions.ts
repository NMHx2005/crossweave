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
