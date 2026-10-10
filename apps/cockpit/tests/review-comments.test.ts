import { describe, expect, test } from 'bun:test'
import { patchSections, type PatchLine } from '../src/lib/patch'
import {
  afterDelivery, anchorOf, deliverReview, emptyReview, formatReview, matchComments, reviewReducer,
  MAX_COMMENT_CHARS, MAX_QUOTE_CHARS, type Anchor, type ReviewComment,
} from '../src/lib/review-comments'
import type { SendTarget } from '../src/lib/prompt-send'

const add = (n: number, text: string): PatchLine => ({ kind: 'add', text: `+${text}`, new: n })
const del = (n: number, text: string): PatchLine => ({ kind: 'del', text: `-${text}`, old: n })
const ctx = (o: number, n: number, text: string): PatchLine => ({ kind: 'context', text: ` ${text}`, old: o, new: n })
const anchor = (path: string, side: 'old' | 'new', line: number, quote: string): Anchor => ({ path, side, line, quote })
const comment = (id: number, a: Anchor, text: string): ReviewComment => ({ ...a, id, text })

describe('anchorOf', () => {
  test('an added or context line anchors to the new file, a deleted one to the old file; the marker is not part of the quote', () => {
    expect(anchorOf('a.ts', add(7, 'let x'))).toEqual(anchor('a.ts', 'new', 7, 'let x'))
    expect(anchorOf('a.ts', ctx(3, 4, 'keep'))).toEqual(anchor('a.ts', 'new', 4, 'keep'))
    expect(anchorOf('a.ts', del(9, 'gone'))).toEqual(anchor('a.ts', 'old', 9, 'gone'))
  })
  test('headers and hunks cannot be commented', () => {
    expect(anchorOf('a.ts', { kind: 'hunk', text: '@@ -1 +1 @@' })).toBeNull()
    expect(anchorOf('a.ts', { kind: 'meta', text: '\\ No newline at end of file' })).toBeNull()
  })
  test('a long line is cut with an ellipsis', () => {
    const q = anchorOf('a.ts', add(1, 'x'.repeat(500)))!.quote
    expect(q.length).toBe(MAX_QUOTE_CHARS)
    expect(q.endsWith('…')).toBe(true)
  })
  test('characters that could rewrite what the person reads become visible marks', () => {
    const q = anchorOf('a.ts', add(1, 'a\rb\u2028c\u202ed'))!.quote
    expect(q).not.toMatch(/[\r\u2028\u202e]/)
    expect(q).toContain('␍')
  })
})

describe('reviewReducer', () => {
  const a = anchor('a.ts', 'new', 1, 'x')
  test('add assigns increasing ids, ignores blank text, caps the length and keeps the first line indent', () => {
    let s = reviewReducer(emptyReview, { type: 'add', anchor: a, text: '   \n ' })
    expect(s.comments).toEqual([])
    s = reviewReducer(s, { type: 'add', anchor: a, text: '\n\n    indented()\nsecond  \n' })
    s = reviewReducer(s, { type: 'add', anchor: a, text: 'y'.repeat(MAX_COMMENT_CHARS + 50) })
    expect(s.comments.map((c) => c.id)).toEqual([1, 2])
    expect(s.comments[0]?.text).toBe('    indented()\nsecond')
    expect(s.comments[1]?.text.length).toBe(MAX_COMMENT_CHARS)
  })
  test('edit changes the text, ignores blank text and unknown ids', () => {
    const s = reviewReducer(emptyReview, { type: 'add', anchor: a, text: 'one' })
    expect(reviewReducer(s, { type: 'edit', id: 1, text: 'two' }).comments[0]?.text).toBe('two')
    expect(reviewReducer(s, { type: 'edit', id: 1, text: '  ' })).toBe(s)
    expect(reviewReducer(s, { type: 'edit', id: 9, text: 'two' })).toBe(s)
  })
  test('delete and clear; ids keep growing after a clear', () => {
    let s = reviewReducer(emptyReview, { type: 'add', anchor: a, text: 'one' })
    s = reviewReducer(s, { type: 'add', anchor: a, text: 'two' })
    expect(reviewReducer(s, { type: 'delete', id: 1 }).comments.map((c) => c.id)).toEqual([2])
    s = reviewReducer(s, { type: 'clear' })
    expect(s.comments).toEqual([])
    expect(reviewReducer(s, { type: 'add', anchor: a, text: 'three' }).comments[0]?.id).toBe(3)
  })
})

describe('matchComments', () => {
  const sections = patchSections(['diff --git a/a.ts b/a.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new', ''].join('\n'))
  test('a comment sits on the line whose path, side, number and text still match, in creation order', () => {
    const c1 = comment(1, anchor('a.ts', 'new', 2, 'new'), 'one')
    const c2 = comment(2, anchor('a.ts', 'new', 2, 'new'), 'two')
    const { byLine, outdated } = matchComments([c1, c2], sections)
    expect([...byLine.values()].flat().map((c) => c.id)).toEqual([1, 2])
    expect(outdated).toEqual([])
  })
  test('an edited, moved or removed line makes the comment outdated, never attaches it elsewhere', () => {
    const edited = comment(1, anchor('a.ts', 'new', 2, 'newer'), 'x')
    const moved = comment(2, anchor('a.ts', 'new', 5, 'new'), 'x')
    const gone = comment(3, anchor('b.ts', 'new', 1, 'keep'), 'x')
    const oldSide = comment(4, anchor('a.ts', 'old', 2, 'old'), 'ok: the deleted line is old line 2')
    const { byLine, outdated } = matchComments([edited, moved, gone, oldSide], sections)
    expect(outdated.map((c) => c.id)).toEqual([1, 2, 3])
    expect([...byLine.values()].flat().map((c) => c.id)).toEqual([4])
  })
})

describe('formatReview', () => {
  test('numbers the items in path, new-before-old, line order, with a header, quotes and a removed-line marker', () => {
    const text = formatReview('the committed changes', [
      comment(1, anchor('b.ts', 'new', 3, 'three'), 'later file'),
      comment(2, anchor('a.ts', 'old', 1, 'was'), 'why removed?'),
      comment(3, anchor('a.ts', 'new', 9, 'nine'), 'rename'),
    ])
    expect(text).toBe([
      'Review comments on the committed changes (3):', '',
      '1. a.ts:9', '   > nine', '   rename',
      '2. a.ts:1 (removed line)', '   > was', '   why removed?',
      '3. b.ts:3', '   > three', '   later file',
    ].join('\n'))
  })
  test('a multi-line comment is indented under its item without trailing spaces; outdated items say so', () => {
    const text = formatReview('x', [comment(1, anchor('a.ts', 'new', 1, 'q'), 'line one\n\n  line three')], new Set([1]))
    expect(text).toBe(['Review comments on x (1):', '', '1. a.ts:1 (outdated)', '   > q', '   line one', '', '     line three'].join('\n'))
  })
})

describe('deliverReview', () => {
  const comments = [comment(1, anchor('a.ts', 'new', 1, 'q'), 'fix')]
  const target = (over: Partial<SendTarget> = {}): SendTarget => ({ id: 's1', name: 'api', running: true, agent: 'claude', ...over })

  test('an agent gets one bracketed paste and never an Enter', async () => {
    const sent: Array<[string, string]> = []
    const out = await deliverReview({ source: 'x', comments, target: target(), send: async (id, data) => { sent.push([id, data]) } })
    expect(out.ok).toBe(true)
    expect(out.message).toContain('Pasted 1 comment into api')
    expect(out.message).toContain('press Enter')
    expect(sent.length).toBe(1)
    expect(sent[0]![1].startsWith('\x1b[200~')).toBe(true)
    expect(sent[0]![1].endsWith('\x1b[201~')).toBe(true)
    expect(sent[0]![1]).not.toContain('\r')
  })
  test('a plain shell is refused (it would run each line) and nothing is sent', async () => {
    let calls = 0
    const out = await deliverReview({ source: 'x', comments, target: target({ agent: null }), send: async () => { calls++ } })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('Not sent to api')
    expect(calls).toBe(0)
  })
  test('a closed shell is refused', async () => {
    const out = await deliverReview({ source: 'x', comments, target: target({ running: false }), send: async () => undefined })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('closed')
  })
  test('a failing send is reported plainly', async () => {
    const out = await deliverReview({ source: 'x', comments, target: target(), send: async () => { throw new Error("Error invoking remote method 'x': SESSION_GONE: no such session") } })
    expect(out).toEqual({ ok: false, message: 'SESSION_GONE: no such session' })
  })
  test('escape sequences in a quote or comment cannot close the paste early', async () => {
    const evil = [comment(1, anchor('a.ts', 'new', 1, 'q\x1b[201~\x00\x9b'), 'a\x1b[201~b\x7f')]
    let data = ''
    await deliverReview({ source: 'x', comments: evil, target: target(), send: async (_id, d) => { data = d } })
    expect(data.indexOf('\x1b[201~')).toBe(data.length - '\x1b[201~'.length)
    expect(data).not.toMatch(/[\x00\x7f\x9b]/)
  })
})

describe('afterDelivery', () => {
  const s = reviewReducer(emptyReview, { type: 'add', anchor: anchor('a', 'new', 1, 'q'), text: 'c' })
  test('a delivered review is cleared; a refused or failed one is kept', () => {
    expect(afterDelivery(s, { ok: true, message: '' }).comments).toEqual([])
    expect(afterDelivery(s, { ok: false, message: '' })).toBe(s)
  })
})
