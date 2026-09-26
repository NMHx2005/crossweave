import { describe, expect, test } from 'bun:test'
import {
  closeOthers, closePane, closeTab, closeToRight, emptyStage, findPane, focusPane, moveTab,
  openInNewTab, paneKey, paneKeys, reconcile, resizeSplit, setPinned, splitPane, toSavedLayout, type PaneRef, type StageState,
} from '../src/lib/layout'

const session = (sessionId: string): PaneRef => ({ kind: 'session', sessionId })
const terminal = (terminalId: string, sessionId: string): PaneRef => ({ kind: 'terminal', terminalId, sessionId })

function stageOf(...ids: string[]): StageState {
  let s = emptyStage()
  for (const id of ids) s = openInNewTab(s, session(id), id)
  return s
}

describe('tabs', () => {
  test('opening a pane makes a new active tab holding it', () => {
    const s = stageOf('a', 'b')
    expect(s.tabs.map((t) => t.title)).toEqual(['a', 'b'])
    expect(s.activeTabId).toBe(s.tabs[1]!.id)
    expect(paneKeys(s)).toEqual(['session:a', 'session:b'])
  })

  test('moving a tab reorders, but never ahead of pinned ones', () => {
    let s = stageOf('a', 'b', 'c')
    s = moveTab(s, s.tabs[2]!.id, 0)
    expect(s.tabs.map((t) => t.title)).toEqual(['c', 'a', 'b'])
    s = setPinned(s, s.tabs[2]!.id, true)
    expect(s.tabs.map((t) => [t.title, t.pinned])).toEqual([['b', true], ['c', false], ['a', false]])
    s = moveTab(s, s.tabs[2]!.id, 0)
    expect(s.tabs.map((t) => t.title)).toEqual(['b', 'a', 'c'])
  })

  test('close others and close to the right skip pinned tabs', () => {
    let s = stageOf('a', 'b', 'c', 'd')
    s = setPinned(s, s.tabs[3]!.id, true) // d pinned, moves first
    expect(s.tabs.map((t) => t.title)).toEqual(['d', 'a', 'b', 'c'])
    const b = s.tabs[2]!.id
    expect(closeToRight(s, b).tabs.map((t) => t.title)).toEqual(['d', 'a', 'b'])
    expect(closeOthers(s, b).tabs.map((t) => t.title)).toEqual(['d', 'b'])
  })

  test('closing the active tab activates a neighbour', () => {
    let s = stageOf('a', 'b', 'c')
    s = closeTab(s, s.activeTabId!)
    expect(s.tabs.map((t) => t.title)).toEqual(['a', 'b'])
    expect(s.activeTabId).toBe(s.tabs[1]!.id)
    expect(closeTab(closeTab(s, s.tabs[0]!.id), s.tabs[1]!.id).activeTabId).toBeNull()
  })
})

describe('splits', () => {
  test('splitting puts the new pane beside the old one and focuses it', () => {
    let s = stageOf('a')
    const tab = s.tabs[0]!
    s = splitPane(s, tab.id, tab.focusedPaneId, 'row', terminal('t1', 'a'))
    const root = s.tabs[0]!.root
    expect(root.type).toBe('split')
    if (root.type !== 'split') return
    expect(root.dir).toBe('row')
    expect(root.sizes).toEqual([0.5, 0.5])
    expect(paneKeys(s)).toEqual(['session:a', 'terminal:t1'])
    expect(findPane(s.tabs[0]!.root, s.tabs[0]!.focusedPaneId)?.pane).toEqual(terminal('t1', 'a'))
  })

  test('closing a pane collapses a split left with one child', () => {
    let s = stageOf('a')
    const tab = s.tabs[0]!
    s = splitPane(s, tab.id, tab.focusedPaneId, 'column', terminal('t1', 'a'))
    const termPane = s.tabs[0]!.focusedPaneId
    s = closePane(s, s.tabs[0]!.id, termPane)
    expect(s.tabs[0]!.root.type).toBe('pane')
    expect(paneKeys(s)).toEqual(['session:a'])
  })

  test('closing the last pane of a tab closes the tab', () => {
    let s = stageOf('a', 'b')
    s = closePane(s, s.tabs[0]!.id, s.tabs[0]!.focusedPaneId)
    expect(s.tabs.map((t) => t.title)).toEqual(['b'])
  })

  test('resizing moves the divider, clamped so no pane vanishes', () => {
    let s = stageOf('a')
    const tab = s.tabs[0]!
    s = splitPane(s, tab.id, tab.focusedPaneId, 'row', session('b'))
    const split = s.tabs[0]!.root
    if (split.type !== 'split') throw new Error('expected split')
    s = resizeSplit(s, s.tabs[0]!.id, split.id, 0, 0.2)
    const after = s.tabs[0]!.root
    if (after.type !== 'split') throw new Error('expected split')
    expect(after.sizes.map((x) => Math.round(x * 100))).toEqual([70, 30])
    s = resizeSplit(s, s.tabs[0]!.id, split.id, 0, 0.9)
    const clamped = s.tabs[0]!.root
    if (clamped.type !== 'split') throw new Error('expected split')
    expect(Math.round(clamped.sizes[1]! * 100)).toBe(10)
  })

  test('focusing a pane makes its tab active', () => {
    let s = stageOf('a', 'b')
    s = focusPane(s, s.tabs[0]!.id, s.tabs[0]!.focusedPaneId)
    expect(s.activeTabId).toBe(s.tabs[0]!.id)
  })
})

describe('reconcile', () => {
  // Sessions and terminals come and go from outside this window.
  test('drops panes whose session or terminal is gone, and empty tabs with them', () => {
    let s = stageOf('a', 'b')
    s = splitPane(s, s.tabs[0]!.id, s.tabs[0]!.focusedPaneId, 'row', terminal('t1', 'a'))
    const next = reconcile(s, { sessionIds: new Set(['a']), terminalIds: new Set() })
    expect(paneKeys(next)).toEqual(['session:a'])
    expect(next.tabs.length).toBe(1)
  })

  test('leaves the state untouched when everything still exists', () => {
    const s = stageOf('a')
    expect(reconcile(s, { sessionIds: new Set(['a']), terminalIds: new Set() })).toBe(s)
  })
})

describe('named layouts', () => {
  test('save by session name and restore onto whatever ids those names have now', async () => {
    const { toSavedLayout, fromSavedLayout } = await import('../src/lib/layout')
    let s = stageOf('id-a')
    s = splitPane(s, s.tabs[0]!.id, s.tabs[0]!.focusedPaneId, 'row', session('id-b'))
    s = splitPane(s, s.tabs[0]!.id, s.tabs[0]!.focusedPaneId, 'column', terminal('t1', 'id-b'))
    const saved = toSavedLayout(s, new Map([['id-a', 'alpha'], ['id-b', 'beta']]))
    // Terminals are ephemeral shells: a saved layout has no way to bring one back.
    expect(JSON.stringify(saved)).not.toContain('t1')
    const restored = fromSavedLayout(saved, new Map([['alpha', 'new-a'], ['beta', 'new-b']]))
    expect(paneKeys(restored)).toEqual(['session:new-a', 'session:new-b'])
  })

  test('a session that no longer exists is left out of the restored layout', async () => {
    const { toSavedLayout, fromSavedLayout } = await import('../src/lib/layout')
    const s = stageOf('id-a', 'id-b')
    const saved = toSavedLayout(s, new Map([['id-a', 'alpha'], ['id-b', 'beta']]))
    expect(paneKeys(fromSavedLayout(saved, new Map([['beta', 'b2']])))).toEqual(['session:b2'])
  })
})

describe('syncStage', () => {
  const live = (sessions: string[], terminals: Array<[string, string]> = []) => ({
    sessions: sessions.map((id) => ({ id, name: id })),
    terminals: terminals.map(([terminalId, sessionId]) => ({ terminalId, sessionId, sessionName: sessionId })),
  })

  test('first load with nothing open: one tab per session', async () => {
    const { syncStage } = await import('../src/lib/layout')
    expect(paneKeys(syncStage(emptyStage(), live(['a', 'b']), null))).toEqual(['session:a', 'session:b'])
  })

  test('a session or terminal that appears later gets its own tab; known ones do not reopen', async () => {
    const { syncStage } = await import('../src/lib/layout')
    let s = syncStage(emptyStage(), live(['a']), null)
    s = closeTab(s, s.tabs[0]!.id) // the user closed a's tab on purpose
    s = syncStage(s, live(['a', 'b'], [['t1', 'a']]), { sessionIds: new Set(['a']), terminalIds: new Set() })
    expect(paneKeys(s)).toEqual(['session:b', 'terminal:t1'])
  })

  test('parseStoredStage accepts only a well-formed stage', async () => {
    const { parseStoredStage } = await import('../src/lib/layout')
    const good = stageOf('a')
    expect(parseStoredStage(JSON.stringify(good))).toEqual(good)
    expect(parseStoredStage('{"tabs":[{"id":1}]}')).toBeNull()
    expect(parseStoredStage('nope')).toBeNull()
  })
})

describe('replacePane', () => {
  test('changes what a pane shows without moving it', async () => {
    const { replacePane } = await import('../src/lib/layout')
    let s = emptyStage()
    s = openInNewTab(s, { kind: 'browser', url: 'http://localhost:3000/' }, 'web')
    s = replacePane(s, s.tabs[0]!.id, s.tabs[0]!.focusedPaneId, { kind: 'browser', url: 'http://localhost:3000/docs' })
    expect(paneKeys(s)).toEqual(['browser:http://localhost:3000/docs'])
  })
})

describe('placeBeside', () => {
  // Opening things by shortcut used to split the focused pane every time, until one
  // tab held four slivers.
  test('splits a tab with one pane, and opens a new tab beside a split one', async () => {
    const { placeBeside } = await import('../src/lib/layout')
    let s = stageOf('a')
    s = placeBeside(s, { kind: 'browser', url: 'http://x/' }, 'web')
    expect(s.tabs.length).toBe(1)
    expect(paneKeys(s)).toEqual(['session:a', 'browser:http://x/'])
    s = placeBeside(s, { kind: 'file', sessionId: 'a', path: 'f.ts' }, 'f.ts')
    expect(s.tabs.length).toBe(2)
    expect(s.activeTabId).toBe(s.tabs[1]!.id)
    expect(placeBeside(emptyStage(), { kind: 'browser', url: 'http://y/' }, 'web').tabs.length).toBe(1)
  })
})

describe('changes panes', () => {
  test('are keyed by session, close with it, and are not saved in a named layout', () => {
    const pane = { kind: 'changes' as const, sessionId: 's1' }
    expect(paneKey(pane)).toBe('changes:s1')
    const stage = openInNewTab(emptyStage(), pane, 'a · changes')
    expect(reconcile(stage, { sessionIds: new Set(), terminalIds: new Set() }).tabs).toEqual([])
    expect(toSavedLayout(stage, new Map([['s1', 'a']])).tabs).toEqual([])
  })
})
