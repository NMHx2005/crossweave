/**
 * Orders concurrent loads by when they STARTED: a result is applied only if no load that started later has already
 * been applied. Without it an older, slower response could overwrite a newer one with a stale list (a session that
 * had just been created vanished from the rail until the next refresh).
 */
export function createLoadGate(): { start: () => number; accept: (seq: number) => boolean } {
  let started = 0
  let applied = 0
  return {
    start: () => ++started,
    accept: (seq) => {
      if (seq <= applied) return false
      applied = seq
      return true
    },
  }
}
