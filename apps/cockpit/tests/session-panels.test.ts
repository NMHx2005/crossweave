import { describe, expect, test } from 'bun:test'
import { emptyStage, focusPane, openInNewTab, resizeSplit, splitPane, toggleZoom, type LayoutNode } from '../src/lib/layout'
import { focusSessionPanel, keepSamePanels, sessionPanelsById } from '../src/lib/session-panels'

describe('sessionPanelsById', () => {
  test('lists a session’s panes in stage order and excludes project-scoped browser panes', () => {
    let stage = openInNewTab(emptyStage(), { kind: 'session', sessionId: 'api' }, 'api')
    const tabId = stage.tabs[0]!.id
    stage = splitPane(stage, tabId, stage.tabs[0]!.focusedPaneId, 'row', { kind: 'terminal', terminalId: 'term-1', sessionId: 'api' })
    stage = splitPane(stage, tabId, stage.tabs[0]!.focusedPaneId, 'column', { kind: 'terminal', terminalId: 'term-2', sessionId: 'api' })
    stage = splitPane(stage, tabId, stage.tabs[0]!.focusedPaneId, 'column', { kind: 'file', sessionId: 'api', path: 'src/App.tsx' })
    stage = openInNewTab(stage, { kind: 'changes', sessionId: 'api' }, 'Changes')
    stage = openInNewTab(stage, { kind: 'debug', sessionId: 'api' }, 'Debug')
    stage = openInNewTab(stage, { kind: 'browser', url: 'http://localhost:3000' }, 'Browser')

    const panels = sessionPanelsById(stage, [{ id: 'api' }, { id: 'worker' }])

    expect(panels.api?.map(({ kind, label }) => [kind, label])).toEqual([
      ['session', 'Agent'],
      ['terminal', 'Terminal 1'],
      ['terminal', 'Terminal 2'],
      ['file', 'App.tsx'],
      ['changes', 'Changes'],
      ['debug', 'Debug'],
    ])
    expect(panels.api?.[3]?.title).toBe('src/App.tsx')
    expect(panels.api?.every(({ tabId: id, paneId }) =>
      stage.tabs.some((tab) => tab.id === id && findPaneId(tab.root, paneId)))).toBe(true)
    expect(panels.worker).toEqual([])
  })

  test('marks only the pane that has the keyboard in the shown tab as active', () => {
    let stage = openInNewTab(emptyStage(), { kind: 'session', sessionId: 'api' }, 'api')
    const tabId = stage.tabs[0]!.id
    const agentPane = stage.tabs[0]!.focusedPaneId
    stage = splitPane(stage, tabId, agentPane, 'row', { kind: 'terminal', terminalId: 'term-1', sessionId: 'api' })
    stage = openInNewTab(stage, { kind: 'changes', sessionId: 'api' }, 'Changes')

    // The terminal is focused inside its tab, but that tab is not the one shown.
    expect(sessionPanelsById(stage, [{ id: 'api' }]).api?.map((p) => p.active)).toEqual([false, false, true])

    stage = focusPane(stage, tabId, agentPane)
    expect(sessionPanelsById(stage, [{ id: 'api' }]).api?.map((p) => p.active)).toEqual([true, false, false])
  })
})

describe('focusSessionPanel', () => {
  test('leaves the stage unchanged when a reported tab or pane has gone away', () => {
    const stage = openInNewTab(emptyStage(), { kind: 'session', sessionId: 'api' }, 'api')
    const tab = stage.tabs[0]!
    const paneId = tab.focusedPaneId

    expect(focusSessionPanel(stage, 'closed-tab', paneId)).toBe(stage)
    expect(focusSessionPanel(stage, tab.id, 'closed-pane')).toBe(stage)
  })

  test('unzooms the tab when the chosen pane is hidden behind another zoomed pane', () => {
    let stage = openInNewTab(emptyStage(), { kind: 'session', sessionId: 'api' }, 'api')
    const tabId = stage.tabs[0]!.id
    const agentPane = stage.tabs[0]!.focusedPaneId
    stage = splitPane(stage, tabId, agentPane, 'row', { kind: 'terminal', terminalId: 'term-1', sessionId: 'api' })
    const terminalPane = stage.tabs[0]!.focusedPaneId
    stage = toggleZoom(stage, tabId, agentPane)

    const next = focusSessionPanel(stage, tabId, terminalPane)

    expect(next.tabs[0]!.focusedPaneId).toBe(terminalPane)
    expect(next.tabs[0]!.zoomedPaneId).toBeUndefined()
  })

  test('keeps the zoom when the chosen pane is the zoomed one', () => {
    let stage = openInNewTab(emptyStage(), { kind: 'session', sessionId: 'api' }, 'api')
    const tabId = stage.tabs[0]!.id
    const agentPane = stage.tabs[0]!.focusedPaneId
    stage = splitPane(stage, tabId, agentPane, 'row', { kind: 'terminal', terminalId: 'term-1', sessionId: 'api' })
    stage = toggleZoom(stage, tabId, agentPane)

    expect(focusSessionPanel(stage, tabId, agentPane).tabs[0]!.zoomedPaneId).toBe(agentPane)
  })
})

describe('keepSamePanels', () => {
  test('returns the previous inventory when only split sizes changed', () => {
    let stage = openInNewTab(emptyStage(), { kind: 'session', sessionId: 'api' }, 'api')
    const tabId = stage.tabs[0]!.id
    stage = splitPane(stage, tabId, stage.tabs[0]!.focusedPaneId, 'row', { kind: 'terminal', terminalId: 'term-1', sessionId: 'api' })
    const before = sessionPanelsById(stage, [{ id: 'api' }])
    const root = stage.tabs[0]!.root
    if (root.type !== 'split') throw new Error('expected a split')
    const resized = resizeSplit(stage, tabId, root.id, 0, 0.1)

    expect(keepSamePanels(before, sessionPanelsById(resized, [{ id: 'api' }]))).toBe(before)
  })

  test('returns the new inventory when a pane, its label or the active pane changed', () => {
    let stage = openInNewTab(emptyStage(), { kind: 'session', sessionId: 'api' }, 'api')
    const tabId = stage.tabs[0]!.id
    const agentPane = stage.tabs[0]!.focusedPaneId
    const before = sessionPanelsById(stage, [{ id: 'api' }])
    stage = splitPane(stage, tabId, agentPane, 'row', { kind: 'terminal', terminalId: 'term-1', sessionId: 'api' })
    const added = sessionPanelsById(stage, [{ id: 'api' }])
    expect(keepSamePanels(before, added)).toBe(added)

    const refocused = sessionPanelsById(focusPane(stage, tabId, agentPane), [{ id: 'api' }])
    expect(keepSamePanels(added, refocused)).toBe(refocused)

    const withWorker = sessionPanelsById(stage, [{ id: 'api' }, { id: 'worker' }])
    expect(keepSamePanels(added, withWorker)).toBe(withWorker)
  })
})

function findPaneId(node: LayoutNode, paneId: string): boolean {
  return node.type === 'pane' ? node.id === paneId : node.children.some((child) => findPaneId(child, paneId))
}
