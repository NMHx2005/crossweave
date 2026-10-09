/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import type { ComponentChildren, VNode } from 'preact'
import { describeRestore, parseCheckpoints, parseRestorePlan } from '../src/lib/checkpoints'
import { CheckpointList } from '../src/ui/CheckpointsDialog'

type Found = { texts: string[]; nodes: VNode[] }
function walk(node: ComponentChildren, out: Found = { texts: [], nodes: [] }): Found {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  const vnode = node as VNode<Record<string, unknown>>
  if (typeof vnode.type === 'function') return walk((vnode.type as (props: unknown) => ComponentChildren)(vnode.props), out)
  out.nodes.push(vnode)
  return walk(vnode.props['children'] as ComponentChildren, out)
}
const text = (f: Found): string => f.texts.join(' ').replace(/\s+/g, ' ')

describe('parseCheckpoints', () => {
  test('keeps well-formed rows in the order sent, and drops malformed ones', () => {
    const out = parseCheckpoints({ checkpoints: [
      { seq: 2, kind: 'turn', at: 20, head: 'abc', files: { added: 1, modified: 0, deleted: 0 } },
      { seq: 'x', kind: 'turn', at: 1, head: 'abc', files: {} },
      { seq: 1, kind: 'bogus', at: 1, head: 'abc', files: {} },
      { seq: 1, kind: 'manual', label: 'start', at: 10, head: 'abc', files: { added: 0, modified: 2, deleted: 1 } },
    ] })
    expect(out.map((c) => c.seq)).toEqual([2, 1])
    expect(out[1]?.label).toBe('start')
    expect(out[1]?.files).toEqual({ added: 0, modified: 2, deleted: 1 })
  })
  test('anything that is not the expected shape is an empty list', () => {
    expect(parseCheckpoints(null)).toEqual([])
    expect(parseCheckpoints({ checkpoints: 'no' })).toEqual([])
  })
})

describe('parseRestorePlan', () => {
  test('takes the plan out of a restore reply, or an empty one', () => {
    expect(parseRestorePlan({ plan: { write: ['a'], delete: ['b'] }, applied: false })).toEqual({ write: ['a'], delete: ['b'] })
    expect(parseRestorePlan({ plan: { write: [1], delete: 'x' } })).toEqual({ write: [], delete: [] })
    expect(parseRestorePlan(undefined)).toEqual({ write: [], delete: [] })
  })
})

describe('describeRestore', () => {
  test('names what changes, promises the return point, and warns about a busy session', () => {
    const plan = { write: ['a.txt', 'b.txt'], delete: ['c.txt'] }
    const calm = describeRestore(3, plan, false)
    expect(calm.title).toBe('Restore checkpoint #3?')
    expect(calm.body).toContain('Write 2 files, delete 1 file.')
    expect(calm.body).toContain('a.txt')
    expect(calm.body).toContain('A return point is saved first.')
    expect(calm.body).not.toContain('looks busy')
    expect(describeRestore(3, plan, true).body).toContain('looks busy')
  })
  test('lists at most 8 paths and counts the rest', () => {
    const plan = { write: Array.from({ length: 12 }, (_, i) => `f${i}.txt`), delete: [] }
    const body = describeRestore(1, plan, false).body
    expect(body).toContain('f7.txt')
    expect(body).not.toContain('f8.txt')
    expect(body).toContain('and 4 more')
  })
  test('says plainly when there is nothing to change', () => {
    expect(describeRestore(1, { write: [], delete: [] }, false).body).toContain('Nothing to change')
  })
})

describe('CheckpointList', () => {
  const noop = () => undefined
  test('says there are none yet', () => {
    expect(text(walk(<CheckpointList rows={[]} now={0} onTurn={noop} onSince={noop} onRestore={noop} />))).toContain('No checkpoints yet')
  })
  test('shows number, kind, label and counts, and disables "This turn" on the oldest row', () => {
    const rows = [
      { seq: 2, kind: 'turn' as const, at: 20, head: 'a', files: { added: 1, modified: 2, deleted: 0 } },
      { seq: 1, kind: 'start' as const, label: 'first', at: 10, head: 'a', files: { added: 0, modified: 0, deleted: 0 } },
    ]
    const found = walk(<CheckpointList rows={rows} now={30} onTurn={noop} onSince={noop} onRestore={noop} />)
    expect(text(found)).toContain('#2')
    expect(text(found)).toContain('turn')
    expect(text(found)).toContain('first')
    expect(text(found)).toContain('+1 ~2 −0')
    const turnButtons = found.nodes.filter((n) => n.type === 'button' && JSON.stringify(n.props['children']).includes('This turn'))
    expect(turnButtons.map((b) => b.props['disabled'])).toEqual([false, true])
  })
})
