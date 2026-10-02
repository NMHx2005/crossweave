/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import type { ComponentChildren, VNode } from 'preact'
import { ResponsesView } from '../src/ui/ResponsesDialog'
import { responseRows } from '../src/lib/responses'
import type { ListedSession } from '../src/lib/sessions'

/**
 * The Responses view: the sessions the last prompt went to, each with its rail state,
 * the agent's latest words and its tests chip. Pure logic (`responseRows`) plus a
 * walk of the view — the exact preview and send live in the composer.
 */

type Found = { texts: string[]; nodes: VNode[] }
function walk(node: ComponentChildren, out: Found = { texts: [], nodes: [] }): Found {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out }
  const v = node as VNode<Record<string, unknown>>
  if (typeof v.type === 'function') return walk((v.type as (p: unknown) => ComponentChildren)(v.props), out)
  out.nodes.push(v)
  return walk(v.props['children'] as ComponentChildren, out)
}
const text = (f: Found): string => f.texts.join(' ').replace(/\s+/g, ' ')
const buttons = (f: Found): VNode[] => f.nodes.filter((n) => n.type === 'button')

const session = (over: Partial<ListedSession> & { id: string; name: string }): ListedSession => over
const byId = (...rows: ListedSession[]): Map<string, ListedSession> => new Map(rows.map((r) => [r.id, r]))

describe('responseRows', () => {
  test('keeps send order, skips a vanished id and a repeat, and reads the rail state', () => {
    const rows = responseRows(
      ['a', 'b', 'a', 'gone'],
      byId(
        session({ id: 'a', name: 'dev', status: 'running', activity: 'asked', rang: true, latestWords: 'need a decision' }),
        session({ id: 'b', name: 'fix', status: 'running', activity: 'working', check: { state: 'pass', at: 1, stale: false, ms: 1000 } }),
      ),
    )
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(rows[0]!.stateLabel).toContain('asking')
    expect(rows[0]!.latestWords).toBe('need a decision')
    expect(rows[1]!.stateLabel).toBe('agent working')
    expect(rows[1]!.check?.label).toBe('✓ tests')
  })

  test('a finished turn reads as done, not asked', () => {
    const rows = responseRows(['a'], byId(session({ id: 'a', name: 'dev', status: 'running', activity: 'asked', rang: false })))
    expect(rows[0]!.state).toBe('done')
    expect(rows[0]!.stateLabel).toBe('agent finished — your turn')
  })
})

describe('ResponsesView', () => {
  const rows = responseRows(['a'], byId(session({ id: 'a', name: 'dev', status: 'running', activity: 'working', latestWords: 'running the tests' })))

  test('a row shows its name, state, words and chip', () => {
    const f = walk(<ResponsesView rows={rows} now={1000} onJump={() => undefined} />)
    expect(text(f)).toContain('dev')
    expect(text(f)).toContain('agent working')
    expect(text(f)).toContain('running the tests')
  })

  test('clicking a row jumps to that session', () => {
    const jumped: string[] = []
    const f = walk(<ResponsesView rows={rows} now={1000} onJump={(id) => jumped.push(id)} />)
    const open = buttons(f)[0]?.props['onClick'] as () => void
    open()
    expect(jumped).toEqual(['a'])
  })

  test('nothing sent yet says so', () => {
    expect(text(walk(<ResponsesView rows={[]} now={1000} onJump={() => undefined} />))).toContain('Nothing sent yet')
  })
})
