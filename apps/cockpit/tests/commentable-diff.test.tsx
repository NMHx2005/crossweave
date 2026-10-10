/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import type { ComponentChildren, VNode } from 'preact'
import { patchSections } from '../src/lib/patch'
import { lineKey, matchComments, type Anchor, type ReviewComment } from '../src/lib/review-comments'
import { CommentEditor, DiffLines, ReviewBar, type DiffLinesProps } from '../src/ui/CommentableDiff'

type Found = { texts: string[]; nodes: VNode<Record<string, any>>[] }
function walk(node: ComponentChildren, out: Found = { texts: [], nodes: [] }): Found {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  const vnode = node as VNode<Record<string, any>>
  if (typeof vnode.type === 'function') return walk((vnode.type as (props: unknown) => ComponentChildren)(vnode.props), out)
  out.nodes.push(vnode)
  return walk(vnode.props['children'] as ComponentChildren, out)
}
const text = (f: Found): string => f.texts.join(' ').replace(/\s+/g, ' ')
const withClass = (f: Found, cls: string): VNode<Record<string, any>>[] => f.nodes.filter((n) => String(n.props['class'] ?? '').split(' ').includes(cls))

const sections = patchSections(['diff --git a/a.ts b/a.ts', 'index 1..2 100644', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new', '\\ No newline at end of file', ''].join('\n'))
const noop = (): void => undefined
const props = (over: Partial<DiffLinesProps> = {}): DiffLinesProps => ({
  sections, byLine: new Map(), composing: null, editing: null,
  onCompose: noop, onAdd: noop, onCancel: noop, onEdit: noop, onSave: noop, onDelete: noop, ...over,
})
const newLine: Anchor = { path: 'a.ts', side: 'new', line: 2, quote: 'new' }
const saved: ReviewComment = { ...newLine, id: 7, text: 'rename this' }

describe('DiffLines', () => {
  test('only added, deleted and context lines carry a comment button, and it names the line', () => {
    const f = walk(DiffLines(props()))
    const labels = withClass(f, 'cockpit-diff-add').map((n) => n.props['aria-label'])
    expect(labels).toEqual(['Comment on a.ts line 1', 'Comment on a.ts line 2 (removed)', 'Comment on a.ts line 2'])
    // 3 file-header lines + the hunk + the "\ No newline" note: no button, a spacer instead.
    expect(withClass(f, 'cockpit-diff-gutter').length).toBe(5)
  })

  test('pressing a button hands over the line it belongs to', () => {
    const seen: Anchor[] = []
    const f = walk(DiffLines(props({ onCompose: (a) => seen.push(a) })))
    withClass(f, 'cockpit-diff-add')[2]!.props['onClick']()
    expect(seen).toEqual([newLine])
  })

  test('a comment shows under its line with Edit and Delete', () => {
    const { byLine } = matchComments([saved], sections)
    const deleted: number[] = []
    const f = walk(DiffLines(props({ byLine, onDelete: (id) => deleted.push(id) })))
    expect(text(f)).toContain('rename this')
    const buttons = withClass(f, 'cockpit-diff-comment__actions')[0]!.props['children'] as VNode<Record<string, any>>[]
    expect(buttons.map((b) => b.props['children'])).toEqual(['Edit', 'Delete'])
    buttons[1]!.props['onClick']()
    expect(deleted).toEqual([7])
  })

  test('the composer opens only under the anchored line, and not under another line with the same number', () => {
    const f = walk(DiffLines(props({ composing: newLine })))
    expect(withClass(f, 'cockpit-diff-editor').length).toBe(1)
    const moved = { ...newLine, quote: 'something else now' }
    expect(withClass(walk(DiffLines(props({ composing: moved }))), 'cockpit-diff-editor').length).toBe(0)
  })

  test('editing replaces the comment text with a prefilled editor', () => {
    const { byLine } = matchComments([saved], sections)
    const f = walk(DiffLines(props({ byLine, editing: 7 })))
    expect(withClass(f, 'cockpit-diff-comment__text').length).toBe(0)
    expect(f.nodes.find((n) => n.type === 'textarea')?.props['children']).toBe('rename this')
  })

  test('a section is told its element so the file list can scroll to it', () => {
    const refs: string[] = []
    const f = walk(DiffLines(props({ sectionRef: (path) => refs.push(path) })))
    const section = f.nodes.find((n) => n.type === 'section')!
    ;(section.ref as unknown as (el: unknown) => void)({})
    expect(refs).toEqual(['a.ts'])
  })
})

describe('CommentEditor', () => {
  const form = (over: Partial<Parameters<typeof CommentEditor>[0]> = {}): VNode<Record<string, any>> =>
    walk(CommentEditor({ submitLabel: 'Add', onSubmit: noop, onCancel: noop, ...over })).nodes.find((n) => n.type === 'form')!

  test('limits the comment length', () => {
    const f = walk(CommentEditor({ submitLabel: 'Add', onSubmit: noop, onCancel: noop }))
    expect(f.nodes.find((n) => n.type === 'textarea')?.props['maxLength']).toBe(2000)
  })
  test('a submit never navigates the window', () => {
    let prevented = false
    form().props['onSubmit']({ preventDefault: () => { prevented = true }, currentTarget: undefined })
    expect(prevented).toBe(true)
  })
  test('Escape cancels and does not reach the dialog behind it', () => {
    let stopped = false
    let cancelled = false
    form({ onCancel: () => { cancelled = true } }).props['onKeyDown']({ code: 'Escape', stopPropagation: () => { stopped = true } })
    expect(stopped && cancelled).toBe(true)
  })
})

describe('ReviewBar', () => {
  const bar = (over: Partial<Parameters<typeof ReviewBar>[0]> = {}): Parameters<typeof ReviewBar>[0] => ({
    count: 2, outdated: [], targetName: 'api', busy: false, onSend: noop, onClear: noop, onDeleteOutdated: noop, ...over,
  })
  test('hidden when there is nothing to send', () => {
    expect(ReviewBar(bar({ count: 0 }))).toBeNull()
  })
  test('shows the count and where it goes; Send is disabled while sending', () => {
    const f = walk(ReviewBar(bar()))
    expect(text(f)).toContain('2 comments')
    expect(text(f)).toContain("Send to api's shell")
    expect(f.nodes.filter((n) => n.type === 'button').every((n) => n.props['disabled'] === false)).toBe(true)
    expect(walk(ReviewBar(bar({ busy: true }))).nodes.filter((n) => n.type === 'button').every((n) => n.props['disabled'] === true)).toBe(true)
  })
  test('lists outdated comments with their old position, and each can be deleted', () => {
    const deleted: number[] = []
    const f = walk(ReviewBar(bar({ outdated: [saved], onDeleteOutdated: (id) => deleted.push(id) })))
    expect(text(f)).toContain('a.ts:2 (outdated)')
    expect(text(f)).toContain('rename this')
    f.nodes.filter((n) => n.type === 'button').at(-1)!.props['onClick']()
    expect(deleted).toEqual([7])
  })
})

test('lineKey is what ties a comment to a row', () => {
  expect(lineKey(newLine)).not.toBe(lineKey({ ...newLine, side: 'old' }))
})
