/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import type { ComponentChildren, VNode } from 'preact'
import { DebugBundleView } from '../src/ui/DebugPane'
import { debugCheckLine, sendableText, type DebugBundle } from '../src/lib/debug-pane'

/**
 * The Debug pane: the bundle's labelled sections, the Send button only when there is
 * sendable text, and the sendable text is the failing tail before the error lines.
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
const buttonNodes = (f: Found, label: string): VNode[] =>
  f.nodes.filter((n) => n.type === 'button' && walk(n).texts.join(' ').includes(label))

const bundle = (over: Partial<DebugBundle> = {}): DebugBundle => ({
  session: { id: 's_1', name: 'dev', status: 'running', branch: 'cw/dev', worktreePath: '/w/dev' },
  agent: 'claude',
  activity: 'working',
  lastActivityAt: 1,
  errors: [],
  diff: { files: [], total: 0, uncommitted: 0 },
  ...over,
})

const pane = (over: Partial<DebugBundle> = {}, onSend: (t: string) => void = () => undefined): Found => walk(
  <DebugBundleView bundle={bundle(over)} error={null} onSend={onSend} />,
)

describe('debugCheckLine', () => {
  test('a failing verdict names the exit code and staleness', () => {
    expect(debugCheckLine({ state: 'fail', code: 1, ms: 2300, stale: true })).toBe('FAIL (exit 1 (2.3s), stale)')
    expect(debugCheckLine({ state: 'pass', ms: 500 })).toBe('pass (0.5s)')
    expect(debugCheckLine({ state: 'running' })).toBe('running')
  })
})

describe('sendableText', () => {
  test('the tail wins over the error lines; nothing → undefined', () => {
    expect(sendableText(bundle({ check: { state: 'fail', tail: 'FAIL a' }, errors: [{ at: 1, line: 'error x' }] }))).toBe('FAIL a')
    expect(sendableText(bundle({ errors: [{ at: 1, line: 'error x' }, { at: 2, line: 'error y' }] }))).toBe('error x\nerror y')
    expect(sendableText(bundle())).toBeUndefined()
  })
})

describe('DebugPane', () => {
  test("the bundle's sections render labelled", () => {
    const f = pane({
      check: { state: 'fail', code: 1, tail: 'FAIL src/a.test.ts' },
      errors: [{ at: 5, line: 'error TS2345: got 1' }],
      diff: { files: [{ path: 'src/a.ts', status: 'modified', added: 2, deleted: 1 }], total: 1, uncommitted: 3 },
      latestWords: 'Plan: split the store',
    })
    expect(text(f)).toContain('agent: claude — working')
    expect(text(f)).toContain('FAIL (exit 1)')
    expect(text(f)).toContain('FAIL src/a.test.ts')
    expect(text(f)).toContain('errors seen in the terminal (heuristic)')
    expect(text(f)).toContain('error TS2345: got 1')
    expect(text(f)).toContain('1 file(s)')
    expect(text(f)).toContain('3 uncommitted')
    expect(text(f)).toContain('latest words')
  })

  test('Send to session drafts the tail (the composer shows the exact preview next)', () => {
    const sent: string[] = []
    const f = pane({ check: { state: 'fail', code: 1, tail: 'FAIL a' } }, (t) => sent.push(t))
    const click = buttonNodes(f, 'Send to session…')[0]?.props['onClick'] as () => void
    click()
    expect(sent).toEqual(['FAIL a'])
  })

  test('nothing sendable → no Send button; an empty bundle renders empties, not blanks', () => {
    const f = pane()
    expect(buttonNodes(f, 'Send to session…')).toHaveLength(0)
    expect(text(f)).toContain('never run')
    expect(text(f)).toContain('nothing to land yet')
  })
})
