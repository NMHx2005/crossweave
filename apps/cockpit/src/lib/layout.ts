/**
 * The Stage's layout: tabs, each holding a tree of split panes. Pure and immutable —
 * every operation returns a new state — so the UI only renders it and the rules
 * (pinned tabs stay first, a split with one child collapses, a pane never shrinks to
 * nothing) are tested here rather than in DOM code.
 */

export type PaneRef =
  | { kind: 'session'; sessionId: string }
  | { kind: 'terminal'; terminalId: string; sessionId: string }
  | { kind: 'file'; sessionId: string; path: string }
  | { kind: 'browser'; url: string }

export type SplitDir = 'row' | 'column'

export type LayoutNode =
  | { type: 'pane'; id: string; pane: PaneRef }
  | { type: 'split'; id: string; dir: SplitDir; sizes: number[]; children: LayoutNode[] }

export type Tab = {
  id: string
  title: string
  pinned: boolean
  root: LayoutNode
  focusedPaneId: string
}

export type StageState = {
  tabs: Tab[]
  activeTabId: string | null
}

/** No pane is dragged below this fraction of its split. */
const MIN_SIZE = 0.1

let counter = 0
const uid = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`

export function emptyStage(): StageState {
  return { tabs: [], activeTabId: null }
}

export function paneKey(pane: PaneRef): string {
  switch (pane.kind) {
    case 'session': return `session:${pane.sessionId}`
    case 'terminal': return `terminal:${pane.terminalId}`
    case 'file': return `file:${pane.sessionId}:${pane.path}`
    case 'browser': return `browser:${pane.url}`
  }
}

function panesOf(node: LayoutNode): Array<{ id: string; pane: PaneRef }> {
  return node.type === 'pane' ? [{ id: node.id, pane: node.pane }] : node.children.flatMap(panesOf)
}

/** Every pane's key, tab by tab, in reading order. */
export function paneKeys(state: StageState): string[] {
  return state.tabs.flatMap((t) => panesOf(t.root).map((p) => paneKey(p.pane)))
}

export function findPane(node: LayoutNode, paneId: string): { id: string; pane: PaneRef } | undefined {
  return panesOf(node).find((p) => p.id === paneId)
}

/** The tab and pane id holding a pane with this key, if any tab does. */
export function locatePane(state: StageState, key: string): { tabId: string; paneId: string } | undefined {
  for (const tab of state.tabs) {
    const hit = panesOf(tab.root).find((p) => paneKey(p.pane) === key)
    if (hit) return { tabId: tab.id, paneId: hit.id }
  }
  return undefined
}

/** Pinned tabs first, each group keeping its order. */
function pinnedFirst(tabs: Tab[]): Tab[] {
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)]
}

function withTab(state: StageState, tabId: string, update: (tab: Tab) => Tab | null): StageState {
  const at = state.tabs.findIndex((t) => t.id === tabId)
  if (at < 0) return state
  const next = update(state.tabs[at]!)
  if (next !== null) {
    const tabs = [...state.tabs]
    tabs[at] = next
    return { ...state, tabs }
  }
  const tabs = state.tabs.filter((t) => t.id !== tabId)
  const activeTabId = state.activeTabId !== tabId
    ? state.activeTabId
    : (tabs[Math.min(at, tabs.length - 1)]?.id ?? null)
  return { tabs, activeTabId }
}

export function openInNewTab(state: StageState, pane: PaneRef, title: string): StageState {
  const paneId = uid('p')
  const tab: Tab = { id: uid('t'), title, pinned: false, root: { type: 'pane', id: paneId, pane }, focusedPaneId: paneId }
  return { tabs: [...state.tabs, tab], activeTabId: tab.id }
}

export function closeTab(state: StageState, tabId: string): StageState {
  return withTab(state, tabId, () => null)
}

export function setPinned(state: StageState, tabId: string, pinned: boolean): StageState {
  return { ...state, tabs: pinnedFirst(state.tabs.map((t) => (t.id === tabId ? { ...t, pinned } : t))) }
}

export function renameTab(state: StageState, tabId: string, title: string): StageState {
  return { ...state, tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) }
}

/** Drop `tabId` at `toIndex`; pinned tabs still come first afterwards. */
export function moveTab(state: StageState, tabId: string, toIndex: number): StageState {
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab) return state
  const rest = state.tabs.filter((t) => t.id !== tabId)
  rest.splice(Math.max(0, Math.min(toIndex, rest.length)), 0, tab)
  return { ...state, tabs: pinnedFirst(rest) }
}

/** Keep `tabId` and every pinned tab. */
export function closeOthers(state: StageState, tabId: string): StageState {
  const tabs = state.tabs.filter((t) => t.id === tabId || t.pinned)
  return { tabs, activeTabId: tabId }
}

/** Close the unpinned tabs after `tabId`. */
export function closeToRight(state: StageState, tabId: string): StageState {
  const at = state.tabs.findIndex((t) => t.id === tabId)
  if (at < 0) return state
  const tabs = state.tabs.filter((t, i) => i <= at || t.pinned)
  const activeTabId = tabs.some((t) => t.id === state.activeTabId) ? state.activeTabId : tabId
  return { tabs, activeTabId }
}

export function focusPane(state: StageState, tabId: string, paneId: string): StageState {
  const next = withTab(state, tabId, (tab) => ({ ...tab, focusedPaneId: paneId }))
  return { ...next, activeTabId: tabId }
}

function mapNode(node: LayoutNode, paneId: string, replace: (n: LayoutNode) => LayoutNode): LayoutNode {
  if (node.type === 'pane') return node.id === paneId ? replace(node) : node
  return { ...node, children: node.children.map((c) => mapNode(c, paneId, replace)) }
}

/** Put `pane` beside `paneId` (row: to its right, column: below) and focus it. */
export function splitPane(state: StageState, tabId: string, paneId: string, dir: SplitDir, pane: PaneRef): StageState {
  const newId = uid('p')
  return withTab(state, tabId, (tab) => ({
    ...tab,
    root: mapNode(tab.root, paneId, (old) => ({
      type: 'split', id: uid('s'), dir, sizes: [0.5, 0.5],
      children: [old, { type: 'pane', id: newId, pane }],
    })),
    focusedPaneId: newId,
  }))
}

/** `node` without `paneId`; a split left with one child becomes that child. */
function without(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === 'pane') return node.id === paneId ? null : node
  const kept: Array<{ child: LayoutNode; size: number }> = []
  node.children.forEach((c, i) => {
    const next = without(c, paneId)
    if (next !== null) kept.push({ child: next, size: node.sizes[i] ?? 0 })
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]!.child
  const total = kept.reduce((sum, k) => sum + k.size, 0) || 1
  return { ...node, children: kept.map((k) => k.child), sizes: kept.map((k) => k.size / total) }
}

/** Close one pane; the tab closes with its last pane. */
export function closePane(state: StageState, tabId: string, paneId: string): StageState {
  return withTab(state, tabId, (tab) => {
    const root = without(tab.root, paneId)
    if (root === null) return null
    const focused = findPane(root, tab.focusedPaneId) ? tab.focusedPaneId : panesOf(root)[0]!.id
    return { ...tab, root, focusedPaneId: focused }
  })
}

/** Move the divider after child `index` of split `splitId` by `delta` (a fraction). */
export function resizeSplit(state: StageState, tabId: string, splitId: string, index: number, delta: number): StageState {
  const resize = (node: LayoutNode): LayoutNode => {
    if (node.type === 'pane') return node
    if (node.id !== splitId) return { ...node, children: node.children.map(resize) }
    const sizes = [...node.sizes]
    const pair = (sizes[index] ?? 0) + (sizes[index + 1] ?? 0)
    const first = Math.max(MIN_SIZE, Math.min(pair - MIN_SIZE, (sizes[index] ?? 0) + delta))
    sizes[index] = first
    sizes[index + 1] = pair - first
    return { ...node, sizes }
  }
  return withTab(state, tabId, (tab) => ({ ...tab, root: resize(tab.root) }))
}

/**
 * Drop panes whose session or terminal no longer exists (and tabs left empty).
 * Returns the SAME state when nothing changed, so a caller can skip a re-render.
 */
export function reconcile(state: StageState, live: { sessionIds: ReadonlySet<string>; terminalIds: ReadonlySet<string> }): StageState {
  const alive = (pane: PaneRef): boolean => {
    if (pane.kind === 'session' || pane.kind === 'file') return live.sessionIds.has(pane.sessionId)
    if (pane.kind === 'terminal') return live.terminalIds.has(pane.terminalId)
    return true
  }
  let next = state
  for (const tab of state.tabs) {
    for (const p of panesOf(tab.root)) {
      if (!alive(p.pane)) next = closePane(next, tab.id, p.id)
    }
  }
  return next
}

/** A layout saved under a name: sessions by NAME, since ids are per workspace. */
export type SavedPane =
  | { kind: 'session'; session: string }
  | { kind: 'file'; session: string; path: string }
  | { kind: 'browser'; url: string }
export type SavedNode =
  | { type: 'pane'; pane: SavedPane }
  | { type: 'split'; dir: SplitDir; sizes: number[]; children: SavedNode[] }
export type SavedLayout = { tabs: Array<{ title: string; pinned: boolean; root: SavedNode }> }

function saveNode(node: LayoutNode, names: ReadonlyMap<string, string>): SavedNode | null {
  if (node.type === 'pane') {
    const p = node.pane
    if (p.kind === 'terminal') return null // an ephemeral shell cannot be brought back
    if (p.kind === 'browser') return { type: 'pane', pane: { kind: 'browser', url: p.url } }
    const name = names.get(p.sessionId)
    if (name === undefined) return null
    return { type: 'pane', pane: p.kind === 'file' ? { kind: 'file', session: name, path: p.path } : { kind: 'session', session: name } }
  }
  const kept: Array<{ child: SavedNode; size: number }> = []
  node.children.forEach((c, i) => {
    const s = saveNode(c, names)
    if (s !== null) kept.push({ child: s, size: node.sizes[i] ?? 0 })
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]!.child
  const total = kept.reduce((sum, k) => sum + k.size, 0) || 1
  return { type: 'split', dir: node.dir, sizes: kept.map((k) => k.size / total), children: kept.map((k) => k.child) }
}

export function toSavedLayout(state: StageState, namesById: ReadonlyMap<string, string>): SavedLayout {
  const tabs: SavedLayout['tabs'] = []
  for (const t of state.tabs) {
    const root = saveNode(t.root, namesById)
    if (root !== null) tabs.push({ title: t.title, pinned: t.pinned, root })
  }
  return { tabs }
}

function loadNode(node: SavedNode, ids: ReadonlyMap<string, string>): LayoutNode | null {
  if (node.type === 'pane') {
    const p = node.pane
    if (p.kind === 'browser') return { type: 'pane', id: uid('p'), pane: { kind: 'browser', url: p.url } }
    const sessionId = ids.get(p.session)
    if (sessionId === undefined) return null
    const pane: PaneRef = p.kind === 'file' ? { kind: 'file', sessionId, path: p.path } : { kind: 'session', sessionId }
    return { type: 'pane', id: uid('p'), pane }
  }
  const kept: Array<{ child: LayoutNode; size: number }> = []
  node.children.forEach((c, i) => {
    const l = loadNode(c, ids)
    if (l !== null) kept.push({ child: l, size: node.sizes[i] ?? 0 })
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]!.child
  const total = kept.reduce((sum, k) => sum + k.size, 0) || 1
  return { type: 'split', id: uid('s'), dir: node.dir, sizes: kept.map((k) => k.size / total), children: kept.map((k) => k.child) }
}

/** Rebuild a saved layout onto the sessions that exist now (by name); others drop out. */
export function fromSavedLayout(saved: SavedLayout, idsByName: ReadonlyMap<string, string>): StageState {
  const tabs: Tab[] = []
  for (const t of saved.tabs ?? []) {
    const root = loadNode(t.root, idsByName)
    if (root === null) continue
    tabs.push({ id: uid('t'), title: t.title, pinned: t.pinned, root, focusedPaneId: panesOf(root)[0]!.id })
  }
  return { tabs: pinnedFirst(tabs), activeTabId: tabs[0]?.id ?? null }
}

type LiveSets = { sessionIds: ReadonlySet<string>; terminalIds: ReadonlySet<string> }

/**
 * Bring the stage in line with what exists: panes of vanished sessions/terminals go,
 * and anything that APPEARED since `known` (started from the CLI, another window, the
 * picker) opens in a tab of its own. `known` null means this window's first load:
 * with nothing restored, every session gets a tab. Something the user closed on
 * purpose is in `known`, so it does not pop back.
 */
export function syncStage(
  state: StageState,
  live: { sessions: Array<{ id: string; name: string }>; terminals: Array<{ terminalId: string; sessionId: string; sessionName: string }> },
  known: LiveSets | null,
): StageState {
  let next = reconcile(state, {
    sessionIds: new Set(live.sessions.map((s) => s.id)),
    terminalIds: new Set(live.terminals.map((t) => t.terminalId)),
  })
  if (known === null) {
    if (next.tabs.length === 0) {
      for (const s of live.sessions) next = openInNewTab(next, { kind: 'session', sessionId: s.id }, s.name)
    }
    return next
  }
  for (const s of live.sessions) {
    if (!known.sessionIds.has(s.id) && !locatePane(next, `session:${s.id}`)) {
      next = openInNewTab(next, { kind: 'session', sessionId: s.id }, s.name)
    }
  }
  for (const t of live.terminals) {
    if (!known.terminalIds.has(t.terminalId) && !locatePane(next, `terminal:${t.terminalId}`)) {
      next = openInNewTab(next, { kind: 'terminal', terminalId: t.terminalId, sessionId: t.sessionId }, `${t.sessionName} · shell`)
    }
  }
  return next
}

function isNode(v: unknown): v is LayoutNode {
  if (typeof v !== 'object' || v === null) return false
  const n = v as Record<string, unknown>
  if (typeof n.id !== 'string') return false
  if (n.type === 'pane') return typeof n.pane === 'object' && n.pane !== null && typeof (n.pane as { kind?: unknown }).kind === 'string'
  return n.type === 'split' && (n.dir === 'row' || n.dir === 'column') && Array.isArray(n.sizes)
    && Array.isArray(n.children) && n.children.length > 0 && n.children.every(isNode)
}

/** A stage read back from storage, or null when it is not one (old format, corrupt). */
export function parseStoredStage(text: string): StageState | null {
  try {
    const v = JSON.parse(text) as { tabs?: unknown; activeTabId?: unknown }
    if (!Array.isArray(v.tabs)) return null
    for (const t of v.tabs as Array<Record<string, unknown>>) {
      if (typeof t.id !== 'string' || typeof t.title !== 'string' || typeof t.pinned !== 'boolean'
        || typeof t.focusedPaneId !== 'string' || !isNode(t.root)) return null
    }
    const tabs = v.tabs as Tab[]
    const activeTabId = typeof v.activeTabId === 'string' && tabs.some((t) => t.id === v.activeTabId) ? v.activeTabId : (tabs[0]?.id ?? null)
    return { tabs, activeTabId }
  } catch {
    return null
  }
}
