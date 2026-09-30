/**
 * The dashboard's model: what the open projects and their sessions cost, and what could be stopped or deleted to lighten the
 * machine. Pure functions over one answer from the main process (`dashboard.get`), so every rule is tested and the page only
 * draws. Nothing here acts: a suggestion is a proposal the person confirms.
 */

export type SessionStat = {
  id: string
  name: string
  /** The daemon's status: idle (stopped), running, waiting, dead, landed. */
  status: string
  branch: string | null
  worktreePath: string | null
  /** It works in the project folder itself: the person's own checkout, never sized or suggested for deletion. */
  shared: boolean
  agent: string | null
  activity: string
  createdAt: string
  lastActiveAt: string
  /** Epoch ms of the last terminal output or input, when known. */
  lastActivityAt: number | null
  /** The session's own disk in bytes; null while it has not been measured yet (or when it has none of its own). */
  diskBytes: number | null
  /** A lower bound: the walk hit its deadline or could not read part of the tree. */
  diskApprox: boolean
  diskMeasuring: boolean
  /** Commits not landed and files not committed; null when unknown (a plain folder, a counter that has not run). */
  ahead: number | null
  changed: number | null
  tokens: number | null
  costUsd: number
}

export type ProjectOverview = {
  workspaceId: string
  root: string
  measuredAt: number
  process: { pid: number; uptimeMs: number; rssBytes: number; heapUsedBytes: number }
  running: number
  terminals: number
  limits: { perSessionBytes: number; perWorkspaceBytes: number }
  sessions: SessionStat[]
  startedPerDay: Record<string, number>
  landedPerDay: Record<string, number>
}

export type ProjectEntry = { root: string; name: string } & (
  | { state: 'ok'; overview: ProjectOverview }
  /** Its daemon predates the dashboard: restart it (that ends its sessions, so the person chooses when). */
  | { state: 'needs-restart' }
  | { state: 'unreachable'; message: string }
)

export type AppFigures = { memoryBytes: number; cpuPercent: number; processes: number }
export type DashboardData = { projects: ProjectEntry[]; app: AppFigures | null; at: number }

export const STALE_EMPTY_DAYS = 7
export const STALE_UNLANDED_DAYS = 14
export const IDLE_SHELL_HOURS = 24
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

// ---- formatting ----------------------------------------------------------------------------------------------

/** "1.5 KB". A missing or nonsensical figure is a dash, never a number that is not one; a negative one is zero. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  const value = Math.max(0, bytes)
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = value
  let unit = -1
  while (v >= 1024 && unit < units.length - 1) { v /= 1024; unit += 1 }
  return `${v.toFixed(1)} ${units[unit]}`
}

// ---- parsing the main process's answer (defensive: it crosses an IPC boundary and an old daemon may send anything) ----

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const nonNegative = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

function perDay(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  const o = obj(v)
  if (o === null) return out
  for (const [day, n] of Object.entries(o)) {
    if (DAY_KEY.test(day) && typeof n === 'number' && Number.isInteger(n) && n >= 0) out[day] = n
  }
  return out
}

function parseSession(v: unknown): SessionStat | null {
  const o = obj(v)
  if (o === null || typeof o['id'] !== 'string' || o['id'] === '' || typeof o['name'] !== 'string' || o['name'] === '') return null
  return {
    id: o['id'], name: o['name'], status: text(o['status'], 'idle'),
    branch: typeof o['branch'] === 'string' ? o['branch'] : null,
    worktreePath: typeof o['worktreePath'] === 'string' ? o['worktreePath'] : null,
    shared: o['shared'] === true,
    agent: typeof o['agent'] === 'string' ? o['agent'] : null,
    activity: text(o['activity'], 'idle'),
    createdAt: text(o['createdAt']), lastActiveAt: text(o['lastActiveAt']),
    lastActivityAt: nonNegative(o['lastActivityAt']),
    diskBytes: nonNegative(o['diskBytes']),
    diskApprox: o['diskApprox'] === true,
    diskMeasuring: o['diskMeasuring'] === true,
    ahead: nonNegative(o['ahead']), changed: nonNegative(o['changed']),
    tokens: nonNegative(o['tokens']), costUsd: nonNegative(o['costUsd']) ?? 0,
  }
}

function parseOverview(v: unknown): ProjectOverview | null {
  const o = obj(v)
  if (o === null || !Array.isArray(o['sessions'])) return null
  const proc = obj(o['process']) ?? {}
  const limits = obj(o['limits']) ?? {}
  return {
    workspaceId: text(o['workspaceId']), root: text(o['root']), measuredAt: nonNegative(o['measuredAt']) ?? 0,
    process: { pid: nonNegative(proc['pid']) ?? 0, uptimeMs: nonNegative(proc['uptimeMs']) ?? 0, rssBytes: nonNegative(proc['rssBytes']) ?? 0, heapUsedBytes: nonNegative(proc['heapUsedBytes']) ?? 0 },
    running: nonNegative(o['running']) ?? 0, terminals: nonNegative(o['terminals']) ?? 0,
    limits: { perSessionBytes: nonNegative(limits['perSessionBytes']) ?? 0, perWorkspaceBytes: nonNegative(limits['perWorkspaceBytes']) ?? 0 },
    sessions: (o['sessions'] as unknown[]).map(parseSession).filter((s): s is SessionStat => s !== null),
    startedPerDay: perDay(o['startedPerDay']), landedPerDay: perDay(o['landedPerDay']),
  }
}

const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/** Whatever `dashboard.get` returned, as a well-formed `DashboardData`: garbage is an empty dashboard, never an exception. */
export function parseDashboard(value: unknown): DashboardData {
  const o = obj(value)
  const projects: ProjectEntry[] = []
  for (const raw of Array.isArray(o?.['projects']) ? (o?.['projects'] as unknown[]) : []) {
    const p = obj(raw)
    if (p === null || typeof p['root'] !== 'string' || p['root'] === '') continue
    const base = { root: p['root'], name: text(p['name']) || baseName(p['root']) }
    if (p['state'] === 'needs-restart') { projects.push({ ...base, state: 'needs-restart' }); continue }
    if (p['state'] === 'ok') {
      const overview = parseOverview(p['overview'])
      projects.push(overview === null ? { ...base, state: 'unreachable', message: 'The daemon sent an answer the window could not read.' } : { ...base, state: 'ok', overview })
      continue
    }
    projects.push({ ...base, state: 'unreachable', message: text(p['message'], 'The daemon did not answer.') })
  }
  const a = obj(o?.['app'])
  const app = a === null ? null : { memoryBytes: nonNegative(a['memoryBytes']) ?? 0, cpuPercent: nonNegative(a['cpuPercent']) ?? 0, processes: nonNegative(a['processes']) ?? 0 }
  return { projects, app, at: nonNegative(o?.['at']) ?? 0 }
}

// ---- totals and rows -----------------------------------------------------------------------------------------

const isRunning = (s: SessionStat): boolean => s.status === 'running' || s.status === 'waiting'
const isEnded = (s: SessionStat): boolean => s.status === 'dead' || s.status === 'landed'
const okProjects = (d: DashboardData): Array<{ entry: ProjectEntry; overview: ProjectOverview }> =>
  d.projects.flatMap((entry) => (entry.state === 'ok' ? [{ entry, overview: entry.overview }] : []))

export type Summary = {
  projects: number
  sessions: { running: number; stopped: number; ended: number; total: number }
  /** What was measured; see `diskUnmeasured` and `diskApprox` for how much to trust it. */
  diskBytes: number
  diskUnmeasured: number
  diskApprox: boolean
  needsRestart: number
  unreachable: number
  /** The app's processes plus every daemon; null when nothing is known. */
  memoryBytes: number | null
}

export function summarize(d: DashboardData): Summary {
  const s: Summary = { projects: d.projects.length, sessions: { running: 0, stopped: 0, ended: 0, total: 0 }, diskBytes: 0, diskUnmeasured: 0, diskApprox: false, needsRestart: 0, unreachable: 0, memoryBytes: null }
  let memory: number | null = d.app === null ? null : d.app.memoryBytes
  for (const p of d.projects) {
    if (p.state === 'needs-restart') s.needsRestart += 1
    else if (p.state === 'unreachable') s.unreachable += 1
  }
  for (const { overview } of okProjects(d)) {
    memory = (memory ?? 0) + overview.process.rssBytes
    for (const x of overview.sessions) {
      s.sessions.total += 1
      if (isRunning(x)) s.sessions.running += 1
      else if (isEnded(x)) s.sessions.ended += 1
      else s.sessions.stopped += 1
      if (x.diskBytes !== null) s.diskBytes += x.diskBytes
      else if (!x.shared) s.diskUnmeasured += 1
      if (x.diskApprox) s.diskApprox = true
    }
  }
  s.memoryBytes = memory
  return s
}

export type ProjectRow = {
  root: string
  name: string
  /** `name`, with its location when two open projects share a folder name. */
  label: string
  state: ProjectEntry['state']
  message: string | null
  sessions: { running: number; stopped: number; ended: number; total: number }
  diskBytes: number | null
  diskMeasuring: boolean
  diskApprox: boolean
  memoryBytes: number | null
  terminals: number
}

export function projectRows(d: DashboardData): ProjectRow[] {
  const dup = new Map<string, number>()
  for (const p of d.projects) dup.set(p.name, (dup.get(p.name) ?? 0) + 1)
  return d.projects.map((p): ProjectRow => {
    const label = (dup.get(p.name) ?? 0) > 1 ? `${p.name} (${baseName(p.root.slice(0, Math.max(0, p.root.lastIndexOf('/'))))})` : p.name
    const empty = { running: 0, stopped: 0, ended: 0, total: 0 }
    if (p.state !== 'ok') return { root: p.root, name: p.name, label, state: p.state, message: p.state === 'unreachable' ? p.message : null, sessions: empty, diskBytes: null, diskMeasuring: false, diskApprox: false, memoryBytes: null, terminals: 0 }
    const o = p.overview
    const counts = { ...empty }
    let disk = 0
    let measuring = false
    let approx = false
    for (const x of o.sessions) {
      counts.total += 1
      if (isRunning(x)) counts.running += 1
      else if (isEnded(x)) counts.ended += 1
      else counts.stopped += 1
      if (x.diskBytes !== null) disk += x.diskBytes
      else if (!x.shared) measuring = true
      if (x.diskApprox) approx = true
    }
    return { root: p.root, name: p.name, label, state: 'ok', message: null, sessions: counts, diskBytes: disk, diskMeasuring: measuring, diskApprox: approx, memoryBytes: o.process.rssBytes, terminals: o.terminals }
  })
}

export type SessionSort = 'disk' | 'name' | 'activity'
export type SessionRow = { projectRoot: string; projectLabel: string; session: SessionStat }

/** The moment the session was last touched, ms since the epoch: terminal activity, else the row's own time, else creation. */
export function lastTouched(s: SessionStat): number | undefined {
  for (const candidate of [s.lastActivityAt, Date.parse(s.lastActiveAt), Date.parse(s.createdAt)]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return undefined
}

export function sessionRows(d: DashboardData, sort: SessionSort): SessionRow[] {
  const labels = new Map(projectRows(d).map((r) => [r.root, r.label]))
  const rows = okProjects(d).flatMap(({ entry, overview }) => overview.sessions.map((session): SessionRow => ({ projectRoot: entry.root, projectLabel: labels.get(entry.root) ?? entry.name, session })))
  // Ties fall to the session's name, then its project's: a deterministic order, whatever order the projects arrived in.
  const byName = (a: SessionRow, b: SessionRow): number => a.session.name.localeCompare(b.session.name) || a.projectLabel.localeCompare(b.projectLabel)
  return rows.sort((a, b) => {
    if (sort === 'disk') {
      const x = a.session.diskBytes
      const y = b.session.diskBytes
      if (x === null && y !== null) return 1
      if (x !== null && y === null) return -1
      if (x !== null && y !== null && x !== y) return y - x
    } else if (sort === 'activity') {
      const x = lastTouched(a.session)
      const y = lastTouched(b.session)
      if (x === undefined && y !== undefined) return 1
      if (x !== undefined && y === undefined) return -1
      if (x !== undefined && y !== undefined && x !== y) return y - x
    } else {
      return byName(a, b)
    }
    return byName(a, b)
  })
}

// ---- suggestions ---------------------------------------------------------------------------------------------

export type SuggestionKind = 'cleanup' | 'delete' | 'unlanded' | 'stop'
export type Suggestion = {
  id: string
  kind: SuggestionKind
  projectRoot: string
  projectName: string
  sessionIds: string[]
  sessionNames: string[]
  title: string
  reason: string
  /** Bytes freed, when it is known; a stop frees memory, not disk, and an unmeasured session is unknown. */
  reclaimBytes: number | null
  /** How careful the action must be: safe (nothing can be lost), confirm (it ends something), unlanded (it would lose work). */
  danger: 'safe' | 'confirm' | 'unlanded'
  /** What deleting would lose, for the confirmation. */
  consequences?: { ahead: number; changed: number }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const hasOwnWorktree = (s: SessionStat): boolean => !s.shared && s.worktreePath !== null

/**
 * What to stop or delete to lighten the machine, biggest reclaim first. Every rule is conservative: it needs positive proof
 * (counts that are known and zero, an age that can be worked out), never suggests a session the person is using, and a session
 * appears at most once. Only projects whose daemon answered are considered.
 */
export function suggestions(d: DashboardData, now: number): Suggestion[] {
  const out: Suggestion[] = []
  for (const { entry, overview } of okProjects(d)) {
    const base = { projectRoot: entry.root, projectName: entry.name }

    const ended = overview.sessions.filter((s) => isEnded(s) && hasOwnWorktree(s))
    // `gc` reclaims a landed session always, and a killed one unless it still holds unlanded work.
    const reclaimable = ended.filter((s) => s.status === 'landed' || !(s.ahead !== null && s.ahead > 0))
    const kept = ended.length - reclaimable.length
    if (reclaimable.length > 0) {
      const known = reclaimable.filter((s) => s.diskBytes !== null)
      out.push({
        ...base, id: `cleanup:${entry.root}`, kind: 'cleanup',
        sessionIds: reclaimable.map((s) => s.id), sessionNames: reclaimable.map((s) => s.name),
        title: `Clean up ${plural(reclaimable.length, 'ended session')}`,
        reason: `${plural(reclaimable.length, 'ended session')} still ${reclaimable.length === 1 ? 'holds' : 'hold'} a worktree.${kept > 0 ? ` Clean up keeps ${plural(kept, 'other')} that still hold unlanded work.` : ''}`,
        reclaimBytes: known.length === 0 ? null : known.reduce((n, s) => n + (s.diskBytes ?? 0), 0),
        danger: 'safe',
      })
    }

    for (const s of overview.sessions) {
      const touched = lastTouched(s)
      if (touched === undefined) continue
      const idleMs = now - touched
      if (s.status === 'idle' && hasOwnWorktree(s)) {
        if (s.ahead === 0 && s.changed === 0 && idleMs >= STALE_EMPTY_DAYS * DAY_MS) {
          out.push({
            ...base, id: `delete:${entry.root}:${s.id}`, kind: 'delete', sessionIds: [s.id], sessionNames: [s.name],
            title: `Delete ${s.name}`, reason: `Stopped for ${Math.floor(idleMs / DAY_MS)} days with nothing to land and nothing uncommitted.`,
            reclaimBytes: s.diskBytes, danger: 'confirm', consequences: { ahead: 0, changed: 0 },
          })
        } else if (((s.ahead ?? 0) > 0 || (s.changed ?? 0) > 0) && idleMs >= STALE_UNLANDED_DAYS * DAY_MS) {
          const ahead = s.ahead ?? 0
          const changed = s.changed ?? 0
          out.push({
            ...base, id: `unlanded:${entry.root}:${s.id}`, kind: 'unlanded', sessionIds: [s.id], sessionNames: [s.name],
            title: `Land or delete ${s.name}`,
            reason: `Untouched for ${Math.floor(idleMs / DAY_MS)} days, and it still holds ${plural(ahead, 'commit')} not landed and ${plural(changed, 'uncommitted file')}.`,
            reclaimBytes: s.diskBytes, danger: 'unlanded', consequences: { ahead, changed },
          })
        }
      } else if (isRunning(s) && s.agent === null && s.activity === 'idle' && idleMs >= IDLE_SHELL_HOURS * HOUR_MS) {
        out.push({
          ...base, id: `stop:${entry.root}:${s.id}`, kind: 'stop', sessionIds: [s.id], sessionNames: [s.name],
          title: `Stop ${s.name}'s shell`, reason: `An idle shell nobody has touched for ${Math.floor(idleMs / HOUR_MS)} hours; nothing runs in it. Stopping it frees its memory and keeps the worktree.`,
          reclaimBytes: null, danger: 'confirm',
        })
      }
    }
  }
  return out.sort((a, b) => {
    if (a.reclaimBytes === null && b.reclaimBytes !== null) return 1
    if (a.reclaimBytes !== null && b.reclaimBytes === null) return -1
    if (a.reclaimBytes !== null && b.reclaimBytes !== null && a.reclaimBytes !== b.reclaimBytes) return b.reclaimBytes - a.reclaimBytes
    return a.title.localeCompare(b.title)
  })
}

// ---- charts --------------------------------------------------------------------------------------------------

export type DiskBar = { root: string; name: string; label: string; bytes: number; approx: boolean }

/** Disk per project, biggest first; a project with nothing measured yet has no bar. */
export function diskByProject(d: DashboardData): DiskBar[] {
  return projectRows(d)
    .filter((r) => r.state === 'ok' && r.diskBytes !== null && (r.diskBytes > 0 || !r.diskMeasuring))
    .map((r): DiskBar => ({ root: r.root, name: r.name, label: r.label, bytes: r.diskBytes ?? 0, approx: r.diskApprox }))
    .sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label))
    .filter((b) => b.bytes > 0)
}

export type DayPoint = { day: string; started: number; landed: number }

/** The last 14 UTC days, oldest first, zero-filled, summed over every project. */
export function perDaySeries(d: DashboardData, now: number, days = 14): DayPoint[] {
  const series: DayPoint[] = []
  for (let i = days - 1; i >= 0; i--) series.push({ day: new Date(now - i * DAY_MS).toISOString().slice(0, 10), started: 0, landed: 0 })
  const at = new Map(series.map((p) => [p.day, p]))
  for (const { overview } of okProjects(d)) {
    for (const [day, n] of Object.entries(overview.startedPerDay)) { const p = at.get(day); if (p) p.started += n }
    for (const [day, n] of Object.entries(overview.landedPerDay)) { const p = at.get(day); if (p) p.landed += n }
  }
  return series
}
