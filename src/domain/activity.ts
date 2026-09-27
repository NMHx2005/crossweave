/** A land that some client (another window, the CLI) finished, worth telling the user. */
export type ActivityKind = 'landed' | 'land_failed';

/**
 * The one parser for the tui.event payloads the cockpit turns into a toast.
 *
 * These are `tui.event` payloads — `NotifyEvent` from src/notify/dispatcher.ts, the same
 * objects the desktop notification and the TUI's own feed line are formatted from.
 * A land (or a failed one) is an item; `convergence` names two sessions and describes
 * a pair, so it is deliberately not — an item is something ONE session needs a human
 * for, and the rail badge already carries the pair's conflict.
 */
export function activityFromEvent(payload: unknown): { kind: ActivityKind; session: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as { kind?: unknown; session?: unknown; ok?: unknown };
  if (typeof record.session !== 'string' || record.session === '') return null;
  if (record.kind === 'land') {
    return { kind: record.ok === false ? 'land_failed' : 'landed', session: record.session };
  }
  return null;
}
