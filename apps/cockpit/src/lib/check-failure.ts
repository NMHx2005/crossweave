import { redactSecrets } from '../../../../src/core/redact-secrets.js'

const MAX_TAIL = 2000

// Order matters: strings and OSC first (their bodies are text), then CSI, then the two-byte escapes.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g
const STRING = /\x1b[P^_X][^\x1b]*(?:\x1b\\|$)/g
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ESC2 = /\x1b[@-Z\\-_]/g
// Characters that show nothing but can carry text or reorder it (the Unicode tag block hides a whole message; bidi controls and
// zero-width characters hide or move one): nothing here may reach a place where the person reads before pressing Enter.
const INVISIBLE = /[\u{E0000}-\u{E007F}\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u061c]/gu
// What is left of the C0/C1 controls once the escape sequences are gone: bell, backspace, a lone ESC, delete. Newline and tab stay;
// `\r` has been collapsed by then.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** What a terminal would leave on screen from a run's output: no escape sequences, progress-bar rewrites collapsed. */
function screenText(raw: string): string {
  const lines = raw
    .replace(OSC, '').replace(STRING, '').replace(CSI, '').replace(ESC2, '').replace(INVISIBLE, '')
    .split('\n')
    .map((line) => {
      const rewritten = line.replace(/\r+$/, '').split('\r')
      return (rewritten[rewritten.length - 1] ?? '').replace(CONTROL, '')
    })
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop()
  return lines.join('\n')
}

/** One line of plain text from repository or test text: nothing a person cannot see, nothing that moves the text, cut at `max`. */
export function plainLine(text: string, max: number): string {
  const one = screenText(text).replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Only a failed verdict has something to send. */
export function canSendFailure(session: { check?: { state: string } }): boolean {
  return session.check?.state === 'fail'
}

/**
 * The text pasted into the shell after a failed check: the verdict in one line and the end of the output, cleaned for reading and
 * stripped of anything that looks like a secret (the run inherits the daemon's whole environment, and an agent reads what is pasted).
 */
export function formatCheckFailure(check: { code?: number; ms?: number; tail?: string; stale: boolean }): string {
  const parts = [check.code === undefined ? null : `exit ${check.code}`, check.ms === undefined ? null : `${(check.ms / 1000).toFixed(1)}s`].filter((p) => p !== null)
  const head = `The project's tests failed${parts.length > 0 ? ` (${parts.join(', ')})` : ''}${check.stale ? ', possibly out of date' : ''}. End of the output:`
  // Cleaned first, redacted second: an invisible character inside a key name defeats the matcher, and removing it afterwards would
  // put the key back together in the pasted text.
  let tail = redactSecrets(screenText(check.tail ?? ''))
  if (tail.length > MAX_TAIL) {
    const cut = tail.slice(-MAX_TAIL)
    const lineStart = cut.indexOf('\n')
    tail = lineStart >= 0 && lineStart < MAX_TAIL / 2 ? cut.slice(lineStart + 1) : cut
  }
  return `${head}\n\n${tail === '' ? '(no output was captured)' : tail}`
}
