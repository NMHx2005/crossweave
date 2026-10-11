import { plainLine } from './check-failure'
import type { ListedSession } from './sessions'

/**
 * Which failed checks the window has not yet told the person about. A run is identified by its start time (`at`), kept per
 * session: comparing one snapshot with the previous one would announce a failure again when a load that resolves late (run 1, run 2,
 * then run 1 again) put an older verdict back, or when a verdict disappears and returns after a daemon restart.
 */
export function createCheckAlerts(): {
  /** Record the failures already there, announcing none: the first look at a project is not news. */
  seed(sessions: readonly ListedSession[]): void
  /** The sessions whose latest failure is new, recorded as told whether or not the caller shows an alert (a failure seen on screen is not announced later). */
  take(sessions: readonly ListedSession[]): ListedSession[]
} {
  const told = new Map<string, Set<number>>()

  // A stale verdict is the person's own news: the tree moved after the run, so the alert would describe work that is gone.
  const failing = (s: ListedSession): s is ListedSession & { check: NonNullable<ListedSession['check']> } =>
    s.check !== undefined && s.check.state === 'fail' && !s.check.stale

  const record = (s: ListedSession & { check: { at: number } }): boolean => {
    const runs = told.get(s.id) ?? new Set<number>()
    const isNew = !runs.has(s.check.at)
    runs.add(s.check.at)
    told.set(s.id, runs)
    return isNew
  }

  return {
    seed(sessions) {
      for (const s of sessions) if (failing(s)) record(s)
    },
    take(sessions) {
      const out: ListedSession[] = []
      for (const s of sessions) if (failing(s) && record(s)) out.push(s)
      return out
    },
  }
}

/** The name is repository text (a branch or a session name): cleaned like any other before it reaches a desktop notification. */
export function checkAlertTitle(name: string): string {
  return `${plainLine(name, 60)}: tests failed`
}

/** Never the output: a notification can sit on a locked screen, and the scrubber is a heuristic. */
export function checkAlertBody(check: { code?: number; ms?: number }): string {
  const parts = [check.code === undefined ? null : `exit ${check.code}`, check.ms === undefined ? null : `${(check.ms / 1000).toFixed(1)}s`].filter((p) => p !== null)
  return parts.length > 0 ? parts.join(', ') : "The project's tests failed"
}
