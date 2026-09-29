export type SendTarget = { id: string; name: string; running: boolean; agent: string | null | undefined }
export type SendItem =
  | { id: string; name: string; how: 'paste' | 'line'; data: string }
  | { id: string; name: string; how: 'refused'; reason: string; data?: undefined }
export type SendPlan = { text: string; items: SendItem[] }

export const MAX_PROMPT_CHARS = 100_000
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * A prompt is text, never keystrokes: line endings are normalised, every control character but tab and newline
 * (an ESC that could end a bracketed paste early, a bell, a NUL, the C1 range) is removed, and the ends are trimmed.
 * The framing below is only safe because nothing that could close it survives this.
 */
export function cleanPromptText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .trimEnd()
}

/**
 * What goes to each session's terminal, decided BEFORE anything is sent so the window can show it. A session that
 * runs an agent gets one bracketed paste (a multi-line prompt arrives as one message; agents' terminals ask for it).
 * A plain shell gets a single line only: a raw newline there would run each line, so a multi-line prompt is refused for
 * it instead. Enter is pressed only when asked, and only after the paste has ended.
 */
export function planSend(text: string, targets: readonly SendTarget[], opts: { enter: boolean }): SendPlan {
  const clean = cleanPromptText(text)
  const enter = opts.enter ? '\r' : ''
  const items = targets.map((t): SendItem => {
    if (clean.trim() === '') return { id: t.id, name: t.name, how: 'refused', reason: 'there is nothing to send' }
    if (clean.length > MAX_PROMPT_CHARS) return { id: t.id, name: t.name, how: 'refused', reason: 'the prompt is too long' }
    if (!t.running) return { id: t.id, name: t.name, how: 'refused', reason: 'its shell is closed' }
    if (t.agent !== null && t.agent !== undefined) return { id: t.id, name: t.name, how: 'paste', data: `${PASTE_START}${clean}${PASTE_END}${enter}` }
    if (clean.includes('\n')) return { id: t.id, name: t.name, how: 'refused', reason: 'a plain shell would run each line: the prompt has more than one line and no agent is running there' }
    return { id: t.id, name: t.name, how: 'line', data: `${clean}${enter}` }
  })
  return { text: clean, items }
}
