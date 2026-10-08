/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import type { ComponentChildren, VNode } from 'preact'
import { SessionPanelChip, SessionPanelList } from '../src/ui/SessionPanelDisclosure'
import type { SessionPanel } from '../src/lib/session-panels'

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

const panels: SessionPanel[] = [
  { tabId: 'tab-1', paneId: 'pane-1', kind: 'session', label: 'Agent', active: false },
  { tabId: 'tab-1', paneId: 'pane-2', kind: 'terminal', label: 'Terminal 1', active: true },
]
const text = (found: Found): string => found.texts.join(' ').replace(/\s+/g, ' ')
const stopped = { stopPropagation: () => undefined }

describe('SessionPanelChip', () => {
  test('shows the count and toggles without reaching the session row', () => {
    let toggles = 0
    let propagated = 0
    const found = walk(<SessionPanelChip id="session-panels-api" sessionName="api" panels={panels} expanded={false} onToggle={() => { toggles += 1 }} />)

    expect(text(found)).toContain('2')
    const chip = found.nodes.find((node) => node.type === 'button')
    expect(chip?.props['aria-expanded']).toBe(false)
    expect(chip?.props['aria-controls']).toBe('session-panels-api')
    ;(chip?.props['onClick'] as (e: unknown) => void)({ stopPropagation: () => { propagated += 1 } })
    expect(toggles).toBe(1)
    expect(propagated).toBe(1)
  })

  test('keeps Enter and Space from opening the session through the row', () => {
    let propagated = 0
    const found = walk(<SessionPanelChip id="x" sessionName="api" panels={panels} expanded={false} onToggle={() => undefined} />)
    const chip = found.nodes.find((node) => node.type === 'button')
    ;(chip?.props['onKeyDown'] as (e: unknown) => void)({ stopPropagation: () => { propagated += 1 } })
    expect(propagated).toBe(1)
  })

  test('is absent when the session has one panel or none — the row itself already opens it', () => {
    expect(walk(<SessionPanelChip id="x" sessionName="api" panels={panels.slice(0, 1)} expanded={false} onToggle={() => undefined} />).nodes).toHaveLength(0)
    expect(walk(<SessionPanelChip id="x" sessionName="api" panels={[]} expanded={false} onToggle={() => undefined} />).nodes).toHaveLength(0)
  })
})

describe('SessionPanelList', () => {
  test('lists the panels, marks the active one and returns the chosen panel', () => {
    const focused: SessionPanel[] = []
    const found = walk(<SessionPanelList id="session-panels-api" sessionName="api" panels={panels} expanded={true} onFocus={(panel) => { focused.push(panel) }} />)

    expect(text(found)).toContain('Agent')
    expect(text(found)).toContain('Terminal 1')
    const buttons = found.nodes.filter((node) => node.type === 'button')
    expect(buttons.map((b) => b.props['aria-current'])).toEqual([undefined, 'true'])
    ;(buttons[1]?.props['onClick'] as (e: unknown) => void)(stopped)
    expect(focused).toEqual([panels[1]])
  })

  test('takes the collapsed list out of the tab order and the accessibility tree', () => {
    const found = walk(<SessionPanelList id="session-panels-api" sessionName="api" panels={panels} expanded={false} onFocus={() => undefined} />)
    const clip = found.nodes.find((node) => node.props['id'] === 'session-panels-api')
    expect(clip?.props['inert']).toBe(true)
  })

  test('renders nothing for a session with fewer than two panels', () => {
    expect(walk(<SessionPanelList id="x" sessionName="api" panels={panels.slice(0, 1)} expanded={true} onFocus={() => undefined} />).nodes).toHaveLength(0)
  })
})
