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
  /** What landing the session would bring in: its diff and its convergence verdict. */
  | { kind: 'changes'; sessionId: string }

export type SplitDir = 'row' | 'column'

export type LayoutNode =
  | { type: 'pane'; id: string; pane: PaneRef }
  | { type: 'split'; id: string; dir: SplitDir; sizes: number[]; children: LayoutNode[] }

export type Tab = {
  id: string
  title: string
  /** The preset last applied (tmux's layout cycle continues from it). */
  preset?: LayoutPreset
  /**
   * tmux's synchronize-panes: what is typed in one terminal pane goes to every other terminal
   * pane of this tab. View state only — never stored, never restored — because input that
   * silently goes everywhere is not something to find switched on after a restart.
   */
  sync?: boolean
  pinned: boolean
  root: LayoutNode
  focusedPaneId: string
  /** tmux's `z`: this pane fills the tab until toggled; the others stay mounted under it. */
  zoomedPaneId?: string
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
    case 'changes': return `changes:${pane.sessionId}`
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

/** Swap what a pane shows (a browser pane's current URL), keeping its place. */
export function replacePane(state: StageState, tabId: string, paneId: string, pane: PaneRef): StageState {
  return withTab(state, tabId, (tab) => ({
    ...tab,
    root: mapNode(tab.root, paneId, (old) => (old.type === 'pane' ? { ...old, pane } : old)),
  }))
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
    const { zoomedPaneId, ...rest } = tab
    // Closing the zoomed pane unzooms; closing another keeps the zoom.
    return { ...rest, root, focusedPaneId: focused, ...(zoomedPaneId !== undefined && zoomedPaneId !== paneId ? { zoomedPaneId } : {}) }
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
    if (pane.kind === 'session' || pane.kind === 'file' || pane.kind === 'changes') return live.sessionIds.has(pane.sessionId)
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
    // An ephemeral shell cannot be brought back; a review pane is reopened on demand.
    if (p.kind === 'terminal' || p.kind === 'changes') return null
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
 * Bring the stage in line with what exists: panes of vanished sessions/terminals go.
 * `known` null means this window's first load: with nothing restored, the newest
 * session that has not ended gets a tab — one, not one per session (ten agents made
 * ten tabs). A session that appears later is not opened: the rail lists it, and this
 * window opens tabs for what it creates itself. A shell that appears later (a split
 * this window asked for) does open.
 */
export function syncStage(
  state: StageState,
  live: { sessions: Array<{ id: string; name: string; status?: string }>; terminals: Array<{ terminalId: string; sessionId: string; sessionName: string }> },
  known: LiveSets | null,
): StageState {
  let next = reconcile(state, {
    sessionIds: new Set(live.sessions.map((s) => s.id)),
    terminalIds: new Set(live.terminals.map((t) => t.terminalId)),
  })
  if (known === null) {
    if (next.tabs.length === 0) {
      const newest = [...live.sessions].reverse().find((s) => s.status !== 'dead' && s.status !== 'landed')
      if (newest) next = openInNewTab(next, { kind: 'session', sessionId: newest.id }, newest.name)
    }
    return next
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
    // `sync` is view state: whatever the file says, a stage always loads with it off.
    const tabs = (v.tabs as Tab[]).map(({ sync: _sync, ...tab }) => tab)
    const activeTabId = typeof v.activeTabId === 'string' && tabs.some((t) => t.id === v.activeTabId) ? v.activeTabId : (tabs[0]?.id ?? null)
    return { tabs, activeTabId }
  } catch {
    return null
  }
}

/**
 * Where a pane opened by shortcut goes: beside the focused pane while the active tab
 * has just one, otherwise in a tab of its own — so repeated opens do not carve one tab
 * into slivers. (The pane bar's split buttons always split: that is an explicit ask.)
 */
export function placeBeside(state: StageState, pane: PaneRef, title: string): StageState {
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  if (tab && tab.root.type === 'pane') return splitPane(state, tab.id, tab.focusedPaneId, 'row', pane)
  return openInNewTab(state, pane, title)
}

/**
 * Every tab, each marked shown or not. The stage renders all of them and hides the
 * rest, so a tab's terminals stay attached while another tab is shown — switching tabs
 * used to unmount every pane and replay it on the way back.
 */
export function liveTabs(state: StageState): Array<{ tab: Tab; shown: boolean }> {
  const active = state.tabs.some((t) => t.id === state.activeTabId) ? state.activeTabId : state.tabs[0]?.id
  return state.tabs.map((tab) => ({ tab, shown: tab.id === active }))
}


// ---------- tmux-like pane operations ----------

/** Zoom `paneId` (fill the tab), or unzoom when it is already zoomed. */
export function toggleZoom(state: StageState, tabId: string, paneId: string): StageState {
  return withTab(state, tabId, (tab) => {
    const { zoomedPaneId, ...rest } = tab
    if (zoomedPaneId === paneId || !findPane(tab.root, paneId)) return rest
    return { ...rest, zoomedPaneId: paneId, focusedPaneId: paneId }
  })
}

export type Rect = { x: number; y: number; w: number; h: number }

/** Where each pane sits in its tab, as fractions of the tab (0..1). */
export function paneRects(node: LayoutNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
  if (node.type === 'pane') {
    out.set(node.id, rect)
    return out
  }
  let offset = 0
  const total = node.sizes.reduce((a, b) => a + b, 0) || 1
  node.children.forEach((child, i) => {
    const share = (node.sizes[i] ?? 0) / total
    const r = node.dir === 'row'
      ? { x: rect.x + offset * rect.w, y: rect.y, w: share * rect.w, h: rect.h }
      : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: share * rect.h }
    offset += share
    paneRects(child, r, out)
  })
  return out
}

export type Direction = 'left' | 'right' | 'up' | 'down'

/**
 * The pane beside `paneId` in `dir` (⌘⌥ + arrow): the nearest one across that edge,
 * preferring the one that overlaps it most along the other axis — as tmux picks.
 */
export function neighbourPane(tab: Tab, paneId: string, dir: Direction): string | undefined {
  const rects = paneRects(tab.root)
  const from = rects.get(paneId)
  if (!from) return undefined
  const eps = 1e-6
  let best: { id: string; gap: number; overlap: number } | undefined
  for (const [id, r] of rects) {
    if (id === paneId) continue
    const gap = dir === 'left' ? from.x - (r.x + r.w)
      : dir === 'right' ? r.x - (from.x + from.w)
        : dir === 'up' ? from.y - (r.y + r.h)
          : r.y - (from.y + from.h)
    if (gap < -eps) continue
    const overlap = dir === 'left' || dir === 'right'
      ? Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y)
      : Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x)
    if (overlap <= eps) continue
    if (!best || gap < best.gap - eps || (Math.abs(gap - best.gap) <= eps && overlap > best.overlap)) best = { id, gap, overlap }
  }
  return best?.id
}

/** Every split in the tab shares its space evenly. */
export function equalize(state: StageState, tabId: string): StageState {
  const even = (node: LayoutNode): LayoutNode => (node.type === 'pane'
    ? node
    : { ...node, sizes: node.children.map(() => 1 / node.children.length), children: node.children.map(even) })
  return withTab(state, tabId, (tab) => ({ ...tab, root: even(tab.root) }))
}

export type LayoutPreset = 'even-horizontal' | 'even-vertical' | 'main-left' | 'tiled'

function split(dir: SplitDir, children: LayoutNode[]): LayoutNode {
  if (children.length === 1) return children[0]!
  return { type: 'split', id: uid('s'), dir, sizes: children.map(() => 1 / children.length), children }
}

/**
 * The tab's panes rearranged (tmux's select-layout): side by side, stacked, the
 * focused one large on the left with the rest stacked beside it, or a grid. Panes keep
 * their ids, so focus and zoom survive; the zoom is dropped (a new layout is meant to
 * be seen).
 */
export function applyPreset(state: StageState, tabId: string, preset: LayoutPreset): StageState {
  return withTab(state, tabId, (tab) => {
    const leaves: LayoutNode[] = panesOf(tab.root).map((p) => ({ type: 'pane', id: p.id, pane: p.pane }))
    const { zoomedPaneId: _dropped, ...rest } = tab
    if (leaves.length < 2) return rest
    let root: LayoutNode
    if (preset === 'even-horizontal') root = split('row', leaves)
    else if (preset === 'even-vertical') root = split('column', leaves)
    else if (preset === 'main-left') {
      const main = leaves.find((l) => l.id === tab.focusedPaneId) ?? leaves[0]!
      const others = leaves.filter((l) => l !== main)
      root = { type: 'split', id: uid('s'), dir: 'row', sizes: [0.6, 0.4], children: [main, split('column', others)] }
    } else {
      const cols = Math.ceil(Math.sqrt(leaves.length))
      const rows: LayoutNode[] = []
      for (let i = 0; i < leaves.length; i += cols) rows.push(split('row', leaves.slice(i, i + cols)))
      root = split('column', rows)
    }
    return { ...rest, root, preset }
  })
}

/** The presets in the order tmux's Space cycles them. */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = ['even-horizontal', 'even-vertical', 'main-left', 'tiled']

/** Arrange the tab in the next preset after the one last applied, wrapping (tmux `Space`). */
export function cyclePreset(state: StageState, tabId: string): StageState {
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab) return state
  const at = tab.preset === undefined ? -1 : LAYOUT_PRESETS.indexOf(tab.preset)
  return applyPreset(state, tabId, LAYOUT_PRESETS[(at + 1) % LAYOUT_PRESETS.length] as LayoutPreset)
}

/** The next (1) or previous (-1) tab becomes active, wrapping (tmux `n` / `p`). */
export function adjacentTab(state: StageState, dir: 1 | -1): StageState {
  if (state.tabs.length < 2) return state
  const at = state.tabs.findIndex((t) => t.id === state.activeTabId)
  const next = state.tabs[((at < 0 ? 0 : at) + dir + state.tabs.length) % state.tabs.length] as Tab
  return { ...state, activeTabId: next.id }
}

/** Swap the focused pane with the next one in reading order (wrapping); focus follows it. */
export function swapNext(state: StageState, tabId: string, paneId: string): StageState {
  return withTab(state, tabId, (tab) => {
    const leaves = panesOf(tab.root)
    const at = leaves.findIndex((l) => l.id === paneId)
    if (at < 0 || leaves.length < 2) return tab
    const other = leaves[(at + 1) % leaves.length]!
    const mine = leaves[at]!
    let root = mapNode(tab.root, mine.id, (n) => ({ ...n, pane: other.pane }) as LayoutNode)
    root = mapNode(root, other.id, (n) => ({ ...n, pane: mine.pane }) as LayoutNode)
    return { ...tab, root, focusedPaneId: other.id }
  })
}

/** tmux's break-pane: the pane leaves its tab for a tab of its own. */
export function paneToTab(state: StageState, tabId: string, paneId: string, title: string): StageState {
  const tab = state.tabs.find((t) => t.id === tabId)
  const found = tab ? findPane(tab.root, paneId) : undefined
  if (!tab || !found || panesOf(tab.root).length < 2) return state
  return openInNewTab(closePane(state, tabId, paneId), found.pane, title)
}

/** Switch synchronize-panes on or off for a tab. */
export function toggleSync(state: StageState, tabId: string): StageState {
  return withTab(state, tabId, (tab) => {
    const { sync, ...rest } = tab
    return sync === true ? rest : { ...rest, sync: true }
  })
}

/**
 * The panes that receive what is typed in `sourcePaneId`: the other TERMINAL panes of a
 * synchronized tab. A browser, a file or a Changes pane has no keyboard to type into.
 */
export function syncTargets(tab: Tab, sourcePaneId: string): string[] {
  if (tab.sync !== true || !findPane(tab.root, sourcePaneId)) return []
  return panesOf(tab.root)
    .filter((p) => p.id !== sourcePaneId && (p.pane.kind === 'session' || p.pane.kind === 'terminal'))
    .map((p) => p.id)
}

/** tmux's break-pane under its own name. */
export const breakPane = paneToTab

/**
 * tmux's move-pane: the pane leaves its tab and lands beside the focused pane of another
 * (side by side, or stacked with `dir: 'column'`); that tab is shown and the pane focused.
 * A tab left empty collapses. To the same tab, or naming a pane or tab that does not exist,
 * it changes nothing — and a pane is never lost or duplicated.
 */
export function movePaneToTab(state: StageState, fromTabId: string, paneId: string, toTabId: string, dir: SplitDir = 'row'): StageState {
  if (fromTabId === toTabId) return state
  const from = state.tabs.find((t) => t.id === fromTabId)
  const to = state.tabs.find((t) => t.id === toTabId)
  const found = from ? findPane(from.root, paneId) : undefined
  if (!from || !to || !found) return state
  // Beside the pane the target tab has focused; if that has vanished, its first pane.
  const anchor = findPane(to.root, to.focusedPaneId) ? to.focusedPaneId : panesOf(to.root)[0]!.id
  const landed = splitPane(closePane(state, fromTabId, paneId), toTabId, anchor, dir, found.pane)
  return { ...landed, activeTabId: toTabId }
}

/** tmux's join-pane: `movePaneToTab` with the arrangement stated. */
export function joinPane(state: StageState, fromTabId: string, paneId: string, toTabId: string, dir: SplitDir): StageState {
  return movePaneToTab(state, fromTabId, paneId, toTabId, dir)
}

export type DropSide = 'left' | 'right' | 'top' | 'bottom'

/**
 * Drag a pane onto another pane's edge: it leaves its place and splits the target on
 * that side. Same tab only; dropping a pane on itself changes nothing.
 */
export function movePane(state: StageState, tabId: string, fromId: string, toId: string, side: DropSide): StageState {
  if (fromId === toId) return state
  const tab = state.tabs.find((t) => t.id === tabId)
  const moving = tab ? findPane(tab.root, fromId) : undefined
  if (!tab || !moving || !findPane(tab.root, toId)) return state
  return withTab(state, tabId, (t) => {
    const root = without(t.root, fromId)
    if (root === null) return t
    const node: LayoutNode = { type: 'pane', id: fromId, pane: moving.pane }
    const dir: SplitDir = side === 'left' || side === 'right' ? 'row' : 'column'
    const before = side === 'left' || side === 'top'
    const placed = mapNode(root, toId, (target) => ({
      type: 'split', id: uid('s'), dir, sizes: [0.5, 0.5], children: before ? [node, target] : [target, node],
    }))
    const { zoomedPaneId: _dropped, ...rest } = t
    return { ...rest, root: placed, focusedPaneId: fromId }
  })
}
