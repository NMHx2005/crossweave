/**
 * Which sessions are touching the same paths as which others — the passive "overlap"
 * signal, the cheap early warning that replaced Collision Radar (removed 2026-09-27,
 * tag v0.3-radar). It is a signal, never a stop: nothing here can prevent a write, and
 * the only hard verdict remains the trial merge.
 *
 * Pure and I/O-free on purpose: the daemon feeds it path sets it already read for the
 * other per-session figures, so this is the whole decision and it can be tested to death.
 */

export interface SessionPaths {
  name: string;
  paths: readonly string[];
}

export interface Overlap {
  /** The other session, by name. */
  session: string;
  /** The paths both sessions have touched, sorted. */
  paths: string[];
}

/**
 * The sessions that overlap, keyed by name. A session with no overlap is absent from
 * the map (so an all-disjoint set is an empty map, and a caller's `get` is `undefined`).
 *
 * Paths are compared as exact strings, in the repo-relative POSIX form git prints —
 * both sides come from the same repo, so there is no normalization to do. Order is
 * deterministic (other session, then path) so two runs over the same input are equal.
 */
export function overlapPairs(sessions: readonly SessionPaths[]): Map<string, Overlap[]> {
  const sets = new Map<string, Set<string>>();
  const names: string[] = [];
  for (const session of sessions) {
    if (sets.has(session.name)) continue;
    names.push(session.name);
    const set = new Set<string>();
    for (const path of session.paths) if (path !== '') set.add(path);
    sets.set(session.name, set);
  }

  const out = new Map<string, Overlap[]>();
  for (const name of names) {
    const mine = sets.get(name) as Set<string>;
    if (mine.size === 0) continue;
    const overlaps: Overlap[] = [];
    for (const other of names) {
      if (other === name) continue;
      const theirs = sets.get(other) as Set<string>;
      const shared = [...mine].filter((path) => theirs.has(path)).sort();
      if (shared.length > 0) overlaps.push({ session: other, paths: shared });
    }
    if (overlaps.length > 0) {
      overlaps.sort((a, b) => a.session.localeCompare(b.session));
      out.set(name, overlaps);
    }
  }
  return out;
}
