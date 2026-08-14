/**
 * Lets any number of `daemon.subscribe`d connections (the TUI, today — nothing else)
 * receive events as they happen, instead of polling. Two message kinds only (spec
 * §3.2): `tui.event` (the full notify()-event payload, for the live radar feed) and
 * `tui.invalidate` (no payload — "something changed, re-fetch session.list/
 * converge.status/workspace.info"). Deliberately not a growing typed-event taxonomy.
 *
 * Backed by a Set, so the same function reference registered twice collapses to one
 * entry — call sites that need two independent subscriptions must pass two distinct
 * closures.
 */
export class BroadcastRegistry {
  private readonly subscribers = new Set<(method: string, params: unknown) => void>();

  subscribe(notify: (method: string, params: unknown) => void): () => void {
    this.subscribers.add(notify);
    return () => this.subscribers.delete(notify);
  }

  broadcast(method: string, params: unknown): void {
    for (const notify of this.subscribers) notify(method, params);
  }
}
