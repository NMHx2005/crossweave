import type { ActivityKind } from '../../../../src/domain/activity.js'

/** The word an activity row shows. */
export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  landed: 'landed',
  land_failed: 'land failed',
}

/**
 * Which badge treatment each kind wears.
 *
 * Reusing the rail's badge classes rather than inventing a second palette for the same
 * states: those are already measured for WCAG AA in tokens.test.ts, and a row that
 * looked different from the badge saying the same thing would be exactly the drift that
 * test exists to prevent. `land_failed` wears `blocked` — a land that did not go through
 * is a stop, not a quieter form of success.
 */
export const ACTIVITY_BADGE: Record<ActivityKind, string> = {
  landed: 'ready',
  land_failed: 'blocked',
}
