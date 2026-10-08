import { findPane, focusPane, panesForSession, type PaneRef, type StageState } from './layout'

export type SessionPanelKind = Exclude<PaneRef['kind'], 'browser'>

export type SessionPanel = {
  tabId: string
  paneId: string
  kind: SessionPanelKind
  label: string
  title?: string
  /** The pane that has the keyboard in the shown tab — where the person is now. */
  active: boolean
}

export type SessionPanelsById = Record<string, SessionPanel[]>

/**
 * A rail item can outlive its pane briefly while a live view report catches up.
 * A zoomed pane covers its siblings, so choosing one of them unzooms the tab: focusing
 * it under the zoom would send the keyboard to a pane nobody can see.
 */
export function focusSessionPanel(stage: StageState, tabId: string, paneId: string): StageState {
  const tab = stage.tabs.find((candidate) => candidate.id === tabId)
  if (!tab || !findPane(tab.root, paneId)) return stage
  if (tab.zoomedPaneId === undefined || tab.zoomedPaneId === paneId) return focusPane(stage, tabId, paneId)
  const { zoomedPaneId: _covered, ...unzoomed } = tab
  return focusPane({ ...stage, tabs: stage.tabs.map((t) => (t.id === tabId ? unzoomed : t)) }, tabId, paneId)
}

/** The rail's panel inventory follows the same session ownership as focusSession. */
export function sessionPanelsById(stage: StageState, sessions: readonly { id: string }[]): SessionPanelsById {
  const shown = stage.tabs.find((tab) => tab.id === stage.activeTabId)
  const result: SessionPanelsById = {}
  for (const session of sessions) {
    const panes = panesForSession(stage, session.id)
    const terminalCount = panes.filter(({ pane }) => pane.kind === 'terminal').length
    let terminalIndex = 0
    result[session.id] = panes.flatMap<SessionPanel>(({ tabId, paneId, pane }) => {
      const active = shown?.id === tabId && shown.focusedPaneId === paneId
      if (pane.kind === 'browser') return []
      if (pane.kind === 'terminal') {
        terminalIndex += 1
        // Numbered in reading order, which is how the person finds them on the stage.
        return [{ tabId, paneId, kind: pane.kind, label: terminalCount > 1 ? `Terminal ${terminalIndex}` : 'Terminal', active }]
      }
      if (pane.kind === 'file') {
        const label = pane.path.split(/[\\/]/).at(-1) || pane.path
        return [{ tabId, paneId, kind: pane.kind, label, title: pane.path, active }]
      }
      if (pane.kind === 'changes') return [{ tabId, paneId, kind: pane.kind, label: 'Changes', active }]
      if (pane.kind === 'debug') return [{ tabId, paneId, kind: pane.kind, label: 'Debug', active }]
      return [{ tabId, paneId, kind: pane.kind, label: 'Agent', active }]
    })
  }
  return result
}

function samePanel(a: SessionPanel, b: SessionPanel): boolean {
  return a.tabId === b.tabId && a.paneId === b.paneId && a.kind === b.kind && a.label === b.label && a.title === b.title && a.active === b.active
}

/**
 * The previous inventory when nothing the rail shows has changed. Dragging a split
 * divider rewrites the stage on every pointer move; without this each move would hand
 * the app a new report and re-render the whole rail.
 */
export function keepSamePanels(previous: SessionPanelsById, next: SessionPanelsById): SessionPanelsById {
  const ids = Object.keys(next)
  if (ids.length !== Object.keys(previous).length) return next
  for (const id of ids) {
    const before = previous[id]
    const after = next[id]!
    if (!before || before.length !== after.length || !after.every((panel, i) => samePanel(panel, before[i]!))) return next
  }
  return previous
}
