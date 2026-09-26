/**
 * A color per session, to tell worktrees apart at a glance (rail dot, tab dot). Only
 * the status tokens the theme already defines, so every choice keeps the contrast the
 * tokens test enforces. Kept per workspace in this window's storage: a view
 * preference, not project state.
 */
export const SESSION_COLORS = ['accent', 'working', 'ready', 'needs-you', 'blocked', 'conflict'] as const
export type SessionColor = (typeof SESSION_COLORS)[number]

const key = (projectRoot: string): string => `cw.colors.v1:${projectRoot}`

export function readColors(projectRoot: string): Record<string, SessionColor> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key(projectRoot)) ?? '{}') as Record<string, unknown>
    const out: Record<string, SessionColor> = {}
    for (const [id, c] of Object.entries(raw)) {
      if ((SESSION_COLORS as readonly string[]).includes(String(c))) out[id] = c as SessionColor
    }
    return out
  } catch {
    return {}
  }
}

export function writeColors(projectRoot: string, colors: Record<string, SessionColor>): void {
  try {
    window.localStorage.setItem(key(projectRoot), JSON.stringify(colors))
  } catch {
    // best effort
  }
}
