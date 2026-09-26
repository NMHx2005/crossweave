// Mirrors the daemon's rule (src/domain/session.ts), so the picker can say what is wrong
// before a round trip.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function sessionNameError(name: string): string | null {
  if (name.trim() === '') return 'Give the session a name'
  if (!NAME.test(name)) return 'Use 1-64 letters, digits, dashes or underscores, starting with a letter or digit'
  return null
}

/** `<agent>-<n>` with the smallest n not taken. */
export function suggestSessionName(agentId: string, taken: readonly string[]): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const name = `${agentId}-${n}`
    if (!used.has(name)) return name
  }
}
