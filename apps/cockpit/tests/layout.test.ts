import { describe, expect, test } from 'bun:test'
import {
  closeOthers, closePane, closeTab, closeToRight, emptyStage, findPane, focusPane, moveTab,
  liveTabs, openInNewTab, paneKey, paneKeys, reconcile, resizeSplit, setPinned, splitPane, toSavedLayout, type PaneRef, type StageState,
  applyPreset, equalize, movePane, neighbourPane, paneRects, paneToTab, swapNext, toggleZoom, type LayoutNode, cyclePreset, adjacentTab,
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

  // Was: one tab per session on first load, and a tab for every session that appeared
  // later. With ten agents that is ten tabs nobody asked for; the rail is where
  // sessions are listed, and a tab is opened by choosing one (or creating it here).
  test('first load with nothing open: one tab, the newest session that has not ended', async () => {
    const { syncStage } = await import('../src/lib/layout')
    const sessions = { sessions: [
      { id: 'a', name: 'a', status: 'idle' }, { id: 'b', name: 'b', status: 'running' }, { id: 'c', name: 'c', status: 'dead' },
    ], terminals: [] }
    expect(paneKeys(syncStage(emptyStage(), sessions, null))).toEqual(['session:b'])
    const ended = { sessions: [{ id: 'c', name: 'c', status: 'landed' }], terminals: [] }
    expect(paneKeys(syncStage(emptyStage(), ended, null))).toEqual([])
  })

  test('a session that appears later is listed in the rail, not opened; a new shell still opens', async () => {
    const { syncStage } = await import('../src/lib/layout')
    let s = syncStage(emptyStage(), live(['a']), null)
    s = syncStage(s, live(['a', 'b'], [['t1', 'a']]), { sessionIds: new Set(['a']), terminalIds: new Set() })
    expect(paneKeys(s)).toEqual(['session:a', 'terminal:t1'])
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

describe('liveTabs', () => {
  test('every tab is rendered; only the active one is shown', () => {
    let s = openInNewTab(emptyStage(), { kind: 'session', sessionId: 'a' }, 'a')
    s = openInNewTab(s, { kind: 'session', sessionId: 'b' }, 'b')
    const first = s.tabs[0]!.id
    s = { ...s, activeTabId: first }
    expect(liveTabs(s).map((t) => [t.tab.id, t.shown])).toEqual([[first, true], [s.tabs[1]!.id, false]])
  })

  test('an active id that names no tab shows the first; no tabs, nothing', () => {
    const s = openInNewTab(emptyStage(), { kind: 'session', sessionId: 'a' }, 'a')
    expect(liveTabs({ ...s, activeTabId: 'gone' })[0]?.shown).toBe(true)
    expect(liveTabs(emptyStage())).toEqual([])
  })
})

describe('tmux-like panes', () => {
  // a | (b / c): a on the left, b above c on the right.
  function three(): { s: StageState; tabId: string; a: string; b: string; c: string } {
    let s = openInNewTab(emptyStage(), session('a'), 'a')
    const tabId = s.tabs[0]!.id
    const a = s.tabs[0]!.focusedPaneId
    s = splitPane(s, tabId, a, 'row', session('b'))
    const b = s.tabs[0]!.focusedPaneId
    s = splitPane(s, tabId, b, 'column', session('c'))
    const c = s.tabs[0]!.focusedPaneId
    return { s, tabId, a, b, c }
  }
  const keys = (node: LayoutNode): string[] => (node.type === 'pane' ? [paneKey(node.pane)] : node.children.flatMap(keys))

  test('paneRects places panes as fractions of the tab', () => {
    const { s, a, b, c } = three()
    const r = paneRects(s.tabs[0]!.root)
    expect(r.get(a)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 })
    expect(r.get(b)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 })
    expect(r.get(c)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  })

  test('neighbourPane moves across edges, and nowhere past the tab', () => {
    const { s, a, b, c } = three()
    const tab = s.tabs[0]!
    // b and c both touch a's right edge with equal overlap: the first in reading order wins.
    expect(neighbourPane(tab, a, 'right')).toBe(b)
    expect(neighbourPane(tab, b, 'down')).toBe(c)
    expect(neighbourPane(tab, c, 'up')).toBe(b)
    expect(neighbourPane(tab, c, 'left')).toBe(a)
    expect(neighbourPane(tab, a, 'left')).toBeUndefined()
    expect(neighbourPane(tab, b, 'up')).toBeUndefined()
  })

  test('zoom toggles, focuses the pane, and survives closing another pane', () => {
    const { s, tabId, b, c } = three()
    let z = toggleZoom(s, tabId, b)
    expect(z.tabs[0]).toMatchObject({ zoomedPaneId: b, focusedPaneId: b })
    z = closePane(z, tabId, c)
    expect(z.tabs[0]!.zoomedPaneId).toBe(b)
    expect(toggleZoom(z, tabId, b).tabs[0]!.zoomedPaneId).toBeUndefined()
    expect(closePane(toggleZoom(s, tabId, b), tabId, b).tabs[0]!.zoomedPaneId).toBeUndefined()
  })

  test('equalize evens every split', () => {
    const { s, tabId } = three()
    const root = equalize(resizeSplit(s, tabId, (s.tabs[0]!.root as { id: string }).id, 0, 0.3), tabId).tabs[0]!.root
    expect(root.type === 'split' && root.sizes).toEqual([0.5, 0.5])
  })

  test('presets keep every pane and its id; main-left puts the focused one first', () => {
    const { s, tabId, a, b, c } = three()
    const byIds = (node: LayoutNode): string[] => (node.type === 'pane' ? [node.id] : node.children.flatMap(byIds))
    const h = applyPreset(s, tabId, 'even-horizontal').tabs[0]!.root
    expect(h.type === 'split' && h.dir).toBe('row')
    expect(byIds(h)).toEqual([a, b, c])
    const v = applyPreset(s, tabId, 'even-vertical').tabs[0]!.root
    expect(v.type === 'split' && [v.dir, v.children.length]).toEqual(['column', 3])
    const main = applyPreset({ ...s, tabs: [{ ...s.tabs[0]!, focusedPaneId: c }] }, tabId, 'main-left').tabs[0]!.root
    expect(byIds(main)[0]).toBe(c)
    const tiled = applyPreset(s, tabId, 'tiled').tabs[0]!.root
    expect(tiled.type === 'split' && tiled.dir).toBe('column')
    expect(byIds(tiled).sort()).toEqual([a, b, c].sort())
  })

  test('swapNext trades places with the next pane; focus follows the moved pane', () => {
    const { s, tabId, a, b } = three()
    const swapped = swapNext(s, tabId, a)
    expect(keys(swapped.tabs[0]!.root)).toEqual(['session:b', 'session:a', 'session:c'])
    expect(swapped.tabs[0]!.focusedPaneId).toBe(b)
  })

  test('paneToTab breaks a pane out into its own tab; a lone pane stays', () => {
    const { s, tabId, c } = three()
    const out = paneToTab(s, tabId, c, 'c')
    expect(out.tabs.map((t) => keys(t.root))).toEqual([['session:a', 'session:b'], ['session:c']])
    expect(out.activeTabId).toBe(out.tabs[1]!.id)
    const lone = openInNewTab(emptyStage(), session('x'), 'x')
    expect(paneToTab(lone, lone.tabs[0]!.id, lone.tabs[0]!.focusedPaneId, 'x')).toBe(lone)
  })

  test("movePane drops a pane on another pane's side", () => {
    const { s, tabId, a, c } = three()
    const moved = movePane(s, tabId, c, a, 'left').tabs[0]!
    expect(keys(moved.root)).toEqual(['session:c', 'session:a', 'session:b'])
    expect(moved.focusedPaneId).toBe(c)
    expect(movePane(s, tabId, a, a, 'top')).toBe(s)
  })
})

describe('cycling the layout preset (tmux Space)', () => {
  const threePanes = (): { s: StageState; tabId: string } => {
    let s = stageOf('a')
    const tabId = s.tabs[0]!.id
    const first = firstOf(s)
    s = splitPane(s, tabId, first, 'row', session('b'))
    s = splitPane(s, tabId, firstOf(s), 'row', session('c'))
    return { s, tabId }
  }
  const firstOf = (s: StageState): string => {
    const walk = (n: LayoutNode): string => (n.type === 'pane' ? n.id : walk(n.children[0]!))
    return walk(s.tabs[0]!.root)
  }
  const shape = (n: LayoutNode): string => (n.type === 'pane' ? 'p' : `${n.dir === 'row' ? 'r' : 'c'}(${n.children.map(shape).join(',')})`)

  test('each call arranges the tab in the next preset, wrapping after the last', () => {
    const { s, tabId } = threePanes()
    const seen: string[] = []
    let cur = s
    for (let i = 0; i < 5; i++) {
      cur = cyclePreset(cur, tabId)
      seen.push(shape(cur.tabs[0]!.root))
    }
    expect(seen[0]).toBe('r(p,p,p)') // even-horizontal first
    expect(seen[1]).toBe('c(p,p,p)') // even-vertical
    expect(new Set(seen.slice(0, 4)).size).toBe(4) // four different arrangements
    expect(seen[4]).toBe(seen[0]) // and it wraps
  })

  test('never loses or duplicates a pane, and a single pane is left alone', () => {
    const { s, tabId } = threePanes()
    const after = cyclePreset(cyclePreset(s, tabId), tabId)
    expect(paneKeys(after).sort()).toEqual(paneKeys(s).sort())
    const one = stageOf('solo')
    expect(cyclePreset(one, one.tabs[0]!.id).tabs[0]!.root).toEqual(one.tabs[0]!.root)
  })
})

describe('adjacent tab (tmux n / p)', () => {
  test('next and previous wrap around the tabs', () => {
    const s = stageOf('a', 'b', 'c') // the last opened is active
    const ids = s.tabs.map((t) => t.id)
    expect(s.activeTabId).toBe(ids[2])
    expect(adjacentTab(s, 1).activeTabId).toBe(ids[0])
    expect(adjacentTab(s, -1).activeTabId).toBe(ids[1])
    expect(adjacentTab(adjacentTab(s, 1), -1).activeTabId).toBe(ids[2])
  })

  test('one tab, or none: nothing changes', () => {
    const one = stageOf('a')
    expect(adjacentTab(one, 1)).toEqual(one)
    expect(adjacentTab(emptyStage(), 1)).toEqual(emptyStage())
  })
})
