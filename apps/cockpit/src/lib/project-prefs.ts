import { SESSION_COLORS, type SessionColor } from './colors'

/**
 * How this window shows and starts things in one project: a display name (the folder
 * is never renamed), a color, and what a new session defaults to. A view preference
 * kept in this window's storage, not project state — another machine, or `cw`, sees
 * the folder as it is.
 */
export type ProjectPrefs = {
  label?: string
  color?: SessionColor
  /** The launcher a new session preselects ('terminal' or a launcher id). */
  launcher?: string
  /** Whether a new session gets its own worktree; the project folder when unset. */
  worktree?: boolean
  /** The branch a new worktree starts from; HEAD when unset. */
  base?: string
  /** Leave killed sessions out of the rail (landed ones always are). */
  hideEnded?: boolean
}

export type PrefsMap = Record<string, ProjectPrefs>

const KEY = 'cw.project-prefs.v1'
const LABEL_MAX = 60

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX)
  return trimmed === '' ? undefined : trimmed
}

function cleanOne(raw: unknown): ProjectPrefs {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: ProjectPrefs = {}
  const label = cleanLabel(r.label)
  if (label !== undefined) out.label = label
  if ((SESSION_COLORS as readonly unknown[]).includes(r.color)) out.color = r.color as SessionColor
  if (typeof r.launcher === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(r.launcher)) out.launcher = r.launcher
  if (typeof r.worktree === 'boolean') out.worktree = r.worktree
  if (typeof r.base === 'string' && r.base.trim() !== '') out.base = r.base.trim()
  if (r.hideEnded === true) out.hideEnded = true
  return out
}

/** Whatever was stored, reduced to what is valid; anything else is dropped, not trusted. */
export function parsePrefs(raw: unknown): PrefsMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PrefsMap = {}
  for (const [root, value] of Object.entries(raw as Record<string, unknown>)) {
    const one = cleanOne(value)
    if (Object.keys(one).length > 0) out[root] = one
  }
  return out
}

/** `patch` over the project's prefs; an undefined field clears it, an empty entry goes. */
export function withPrefs(map: PrefsMap, root: string, patch: Partial<Record<keyof ProjectPrefs, unknown>>): PrefsMap {
  const merged: Record<string, unknown> = { ...map[root] }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  const one = cleanOne(merged)
  const next = { ...map }
  if (Object.keys(one).length === 0) delete next[root]
  else next[root] = one
  return next
}

/** The name the rail shows: the chosen label, else the workspace's own name. */
export function projectLabel(prefs: ProjectPrefs | undefined, fallback: string): string {
  return prefs?.label ?? fallback
}

/** `order` with `root` moved `delta` places (clamped); unchanged when it is not there. */
export function moveProject(order: readonly string[], root: string, delta: number): string[] {
  const from = order.indexOf(root)
  if (from < 0) return [...order]
  const to = Math.max(0, Math.min(order.length - 1, from + delta))
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, root)
  return next
}

export function readPrefs(): PrefsMap {
  try {
    return parsePrefs(JSON.parse(localStorage.getItem(KEY) ?? '{}'))
  } catch {
    return {}
  }
}

export function writePrefs(map: PrefsMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    // a convenience: the rail shows folder names again next time
  }
}
