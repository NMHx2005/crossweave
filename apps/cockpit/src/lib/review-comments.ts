import { plainErrorMessage } from './cockpit-host'
import type { PatchLine, PatchSection } from './patch'
import { planSend, type SendTarget } from './prompt-send'

/** `new` is a line of the file after the change (added or context), `old` a deleted line of the file before it. */
export type Side = 'old' | 'new'
/** Where a comment sits. `quote` is the line's text: it finds the place again after the file has moved on. */
export type Anchor = { path: string; side: Side; line: number; quote: string }
export type ReviewComment = Anchor & { id: number; text: string }
export type ReviewState = { comments: ReviewComment[]; nextId: number }
export type ReviewAction =
  | { type: 'add'; anchor: Anchor; text: string }
  | { type: 'edit'; id: number; text: string }
  | { type: 'delete'; id: number }
  | { type: 'clear' }
  | { type: 'delivered'; delivery: Delivery }

export const MAX_COMMENT_CHARS = 2000
export const MAX_QUOTE_CHARS = 200
export const emptyReview: ReviewState = { comments: [], nextId: 1 }

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * A quote is diff content, which an agent or a repository wrote. `cleanPromptText` turns a bare CR into a newline, which
 * would let a quote forge a numbered item of its own, and bidi controls can reorder what the person reads before pressing
 * Enter: show them as visible marks instead.
 */
function displaySafe(s: string): string {
  return s.replace(/\r/g, '␍').replace(/[\u2028\u2029]/g, '␤').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '⁇')
}

/** Leading blank lines and trailing space go; the first real line keeps its indent (it may be code). */
function tidy(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd().slice(0, MAX_COMMENT_CHARS).trimEnd()
}

export function anchorOf(path: string, line: PatchLine): Anchor | null {
  const quote = (): string => cut(displaySafe(line.text.slice(1)), MAX_QUOTE_CHARS)
  if ((line.kind === 'add' || line.kind === 'context') && line.new !== undefined) return { path, side: 'new', line: line.new, quote: quote() }
  if (line.kind === 'del' && line.old !== undefined) return { path, side: 'old', line: line.old, quote: quote() }
  return null
}

export const lineKey = (a: Pick<Anchor, 'path' | 'side' | 'line'>): string => `${a.path}\0${a.side}\0${a.line}`

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'add': {
      const text = tidy(action.text)
      if (text === '') return state
      return { comments: [...state.comments, { ...action.anchor, id: state.nextId, text }], nextId: state.nextId + 1 }
    }
    case 'edit': {
      const text = tidy(action.text)
      if (text === '' || !state.comments.some((c) => c.id === action.id)) return state
      return { ...state, comments: state.comments.map((c) => (c.id === action.id ? { ...c, text } : c)) }
    }
    case 'delete': return { ...state, comments: state.comments.filter((c) => c.id !== action.id) }
    case 'clear': return { ...state, comments: [] }
    case 'delivered': return afterDelivery(state, action.delivery)
  }
}

/**
 * Comments matched back to the lines of a (re)loaded diff by path, side, number AND text. One that no longer matches is
 * `outdated`: it stays visible and sendable instead of being dropped or attached to whatever line now has that number.
 */
export function matchComments(comments: readonly ReviewComment[], sections: readonly PatchSection[]): { byLine: Map<string, ReviewComment[]>; outdated: ReviewComment[] } {
  const quotes = new Map<string, string>()
  for (const section of sections) {
    for (const line of section.lines) {
      const a = anchorOf(section.path, line)
      if (a !== null) quotes.set(lineKey(a), a.quote)
    }
  }
  const byLine = new Map<string, ReviewComment[]>()
  const outdated: ReviewComment[] = []
  for (const c of comments) {
    const key = lineKey(c)
    if (quotes.get(key) === c.quote) byLine.set(key, [...(byLine.get(key) ?? []), c])
    else outdated.push(c)
  }
  return { byLine, outdated }
}

export function formatReview(source: string, comments: readonly ReviewComment[], outdated: ReadonlySet<number> = new Set()): string {
  const sorted = [...comments].sort((a, b) =>
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || (a.side === b.side ? 0 : a.side === 'new' ? -1 : 1)
    || a.line - b.line
    || a.id - b.id)
  const items = sorted.map((c, i) => {
    const mark = `${c.side === 'old' ? ' (removed line)' : ''}${outdated.has(c.id) ? ' (outdated)' : ''}`
    const body = c.text.split('\n').map((l) => `   ${l}`.trimEnd()).join('\n')
    return `${i + 1}. ${c.path}:${c.line}${mark}\n   > ${c.quote}\n${body}`
  })
  return `Review comments on ${source} (${comments.length}):\n\n${items.join('\n')}`
}

export type Delivery = { ok: boolean; message: string }

/**
 * Pastes the review into the session's shell WITHOUT Enter: `planSend` decides first (an agent gets one bracketed paste, a
 * plain shell is refused because each line would run, a closed shell is refused) and cleans every control character.
 */
export async function deliverReview(o: {
  source: string
  comments: readonly ReviewComment[]
  outdated?: ReadonlySet<number>
  target: SendTarget
  send: (id: string, data: string) => Promise<unknown>
}): Promise<Delivery> {
  const plan = planSend(formatReview(o.source, o.comments, o.outdated), [o.target], { enter: false })
  const item = plan.items[0]
  if (item === undefined || item.how === 'refused') return { ok: false, message: `Not sent to ${o.target.name}: ${item?.reason ?? 'there is nothing to send'}` }
  try {
    await o.send(item.id, item.data)
  } catch (err) {
    return { ok: false, message: plainErrorMessage(err) }
  }
  const n = o.comments.length
  return { ok: true, message: `Pasted ${n} comment${n === 1 ? '' : 's'} into ${o.target.name}'s shell — press Enter there to send ${n === 1 ? 'it' : 'them'}` }
}

/** What the review becomes once delivery is known: cleared when it arrived, kept (to retry or fix) when it did not. */
export function afterDelivery(state: ReviewState, delivery: Delivery): ReviewState {
  return delivery.ok ? { ...state, comments: [] } : state
}
