import { useRef, useState } from 'preact/hooks'
import type { ListedSession } from '../host/cockpit-api'
import type { LayoutNode, PaneRef, SplitDir, StageState, Tab } from '../lib/layout'
import { sessionSource, terminalSource, type InAppOpener } from '../lib/pane-source'
import type { SessionColor } from '../lib/colors'
import { XtermPane } from './XtermPane'

export type StageStatus = 'loading' | 'ready' | 'empty' | 'error'

export type StageProps = {
  stage: StageState
  sessions: ListedSession[]
  status: StageStatus
  error: string | null
  /** Try attaching the workspace again after a failure. */
  onRetry: () => void
  /** Global re-attach epoch — daemon.gone replaces every pane's connection. */
  paneAttachEpoch?: number
  /** Per-session re-attach counters: a session that started re-keys only its panes. */
  paneAttachBumps?: Record<string, number>
  onActivateTab: (tabId: string) => void
  onFocusPane: (tabId: string, paneId: string) => void
  onClosePane: (tabId: string, paneId: string, pane: PaneRef) => void
  onSplit: (tabId: string, paneId: string, dir: SplitDir, pane: PaneRef) => void
  onResize: (tabId: string, splitId: string, index: number, delta: number) => void
  onMoveTab: (tabId: string, toIndex: number) => void
  onPinTab: (tabId: string, pinned: boolean) => void
  onCloseTab: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  layouts: string[]
  onSaveLayout: (name: string) => void
  onApplyLayout: (name: string) => void
  onDeleteLayout: (name: string) => void
  /** File and browser panes, rendered by the app (they need its handlers). */
  renderSurface?: (pane: PaneRef, focused: boolean, at: { tabId: string; paneId: string }) => preact.ComponentChildren
  /** Cmd+click with the in-app editor chosen: open the file in a pane. */
  inApp?: InAppOpener
  /** Session colors (colors.ts), shown as a dot on the tabs they lead. */
  colorById?: Record<string, SessionColor>
}

function paneLabel(pane: PaneRef, names: ReadonlyMap<string, string>): string {
  switch (pane.kind) {
    case 'session': return names.get(pane.sessionId) ?? pane.sessionId
    case 'terminal': return `${names.get(pane.sessionId) ?? pane.sessionId} · shell`
    case 'file': return pane.path.split('/').pop() ?? pane.path
    case 'browser': return pane.url.replace(/^https?:\/\//, '')
  }
}

function firstPane(node: LayoutNode): PaneRef {
  return node.type === 'pane' ? node.pane : firstPane(node.children[0]!)
}

function paneCount(node: LayoutNode): number {
  return node.type === 'pane' ? 1 : node.children.reduce((n, c) => n + paneCount(c), 0)
}

type TabMenu = { tabId: string; x: number; y: number }

export function Stage(props: StageProps) {
  const { stage, sessions, status, error, paneAttachEpoch = 0, paneAttachBumps = {} } = props
  const names = new Map(sessions.map((s) => [s.id, s.name]))
  const active = stage.tabs.find((t) => t.id === stage.activeTabId) ?? null
  const [menu, setMenu] = useState<TabMenu | null>(null)
  const [layoutsOpen, setLayoutsOpen] = useState(false)
  const [layoutName, setLayoutName] = useState('')
  const dragTab = useRef<string | null>(null)

  const tabLabel = (tab: Tab): string => {
    const n = paneCount(tab.root)
    return `${paneLabel(firstPane(tab.root), names)}${n > 1 ? ` +${n - 1}` : ''}`
  }

  const renderNode = (tab: Tab, node: LayoutNode): preact.ComponentChildren => {
    if (node.type === 'split') {
      return (
        <div class={`cockpit-split cockpit-split--${node.dir}`} key={node.id}>
          {node.children.map((child, i) => [
            <div class="cockpit-split__cell" style={{ flexGrow: node.sizes[i] ?? 1 }} key={child.id}>
              {renderNode(tab, child)}
            </div>,
            i < node.children.length - 1 ? (
              <Divider
                key={`${child.id}:divider`}
                dir={node.dir}
                onDrag={(delta) => props.onResize(tab.id, node.id, i, delta)}
              />
            ) : null,
          ])}
        </div>
      )
    }
    const { pane } = node
    const focused = tab.focusedPaneId === node.id
    const hasSession = pane.kind !== 'browser'
    return (
      <div
        key={node.id}
        class={focused ? 'cockpit-pane is-focused' : 'cockpit-pane'}
        onMouseDown={() => { if (!focused) props.onFocusPane(tab.id, node.id) }}
      >
        <div class="cockpit-pane-bar">
          <span class="cockpit-pane-bar__title">{paneLabel(pane, names)}</span>
          {pane.kind === 'terminal' ? (
            // Honest about coverage: a shell has no hook, so Radar cannot stop its writes.
            <span class="cockpit-pane-bar__note" title="Writes typed here are not checked by Collision Radar">not guarded</span>
          ) : null}
          {hasSession ? (
            <>
              <button type="button" class="cockpit-pane-bar__btn" title="Split right: a shell in this worktree"
                onClick={() => props.onSplit(tab.id, node.id, 'row', pane)}>⇥</button>
              <button type="button" class="cockpit-pane-bar__btn" title="Split down: a shell in this worktree"
                onClick={() => props.onSplit(tab.id, node.id, 'column', pane)}>⤓</button>
            </>
          ) : null}
          <button type="button" class="cockpit-pane-bar__close" aria-label={`Close ${paneLabel(pane, names)}`}
            onClick={(e) => { e.stopPropagation(); props.onClosePane(tab.id, node.id, pane) }}>×</button>
        </div>
        {pane.kind === 'session' ? (
          <XtermPane
            key={`${pane.sessionId}:${paneAttachEpoch}:${paneAttachBumps[pane.sessionId] ?? 0}`}
            source={sessionSource(pane.sessionId, props.inApp)}
            focused={focused}
          />
        ) : pane.kind === 'terminal' ? (
          <XtermPane
            key={`terminal:${pane.terminalId}:${paneAttachEpoch}`}
            source={terminalSource(pane.terminalId, pane.sessionId, props.inApp)}
            focused={focused}
          />
        ) : (
          props.renderSurface?.(pane, focused, { tabId: tab.id, paneId: node.id }) ?? null
        )}
      </div>
    )
  }

  const tabMenuItems = (tabId: string) => {
    const tab = stage.tabs.find((t) => t.id === tabId)
    if (!tab) return []
    return [
      { label: tab.pinned ? 'Unpin' : 'Pin', run: () => props.onPinTab(tabId, !tab.pinned) },
      { label: 'Close', run: () => props.onCloseTab(tabId) },
      { label: 'Close Others', run: () => props.onCloseOthers(tabId) },
      { label: 'Close to the Right', run: () => props.onCloseToRight(tabId) },
    ]
  }

  return (
    <main class="cockpit-stage" aria-label="Stage" onClick={() => { setMenu(null) }}>
      <div class="cockpit-tabs" role="tablist" aria-label="Tabs">
        {stage.tabs.map((tab, index) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === stage.activeTabId}
            class={`cockpit-tab${tab.id === stage.activeTabId ? ' is-active' : ''}${tab.pinned ? ' is-pinned' : ''}`}
            draggable
            onDragStart={() => { dragTab.current = tab.id }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (dragTab.current !== null && dragTab.current !== tab.id) props.onMoveTab(dragTab.current, index)
              dragTab.current = null
            }}
            onClick={() => props.onActivateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
            }}
          >
            {tab.pinned ? <span class="cockpit-tab__pin" aria-label="Pinned">📌</span> : null}
            {(() => {
              const lead = firstPane(tab.root)
              const color = lead.kind !== 'browser' ? props.colorById?.[lead.sessionId] : undefined
              return color ? <span class="cockpit-dot" style={{ background: `var(--cw-${color})` }} aria-hidden="true" /> : null
            })()}
            <span class="cockpit-tab__title">{tabLabel(tab)}</span>
            {!tab.pinned ? (
              <button type="button" class="cockpit-tab__close" aria-label={`Close tab ${tabLabel(tab)}`}
                onClick={(e) => { e.stopPropagation(); props.onCloseTab(tab.id) }}>×</button>
            ) : null}
          </div>
        ))}
        <div class="cockpit-tabs__spacer" />
        <div class="cockpit-layouts">
          <button type="button" class="cockpit-layouts__toggle" onClick={(e) => { e.stopPropagation(); setLayoutsOpen(!layoutsOpen) }}>
            Layouts ▾
          </button>
          {layoutsOpen ? (
            <div class="cockpit-layouts__menu" onClick={(e) => e.stopPropagation()}>
              {props.layouts.length === 0 ? <p class="cockpit-muted">No saved layouts.</p> : null}
              {props.layouts.map((name) => (
                <div class="cockpit-layouts__row" key={name}>
                  <button type="button" class="cockpit-layouts__apply" onClick={() => { props.onApplyLayout(name); setLayoutsOpen(false) }}>{name}</button>
                  <button type="button" class="cockpit-layouts__delete" aria-label={`Delete layout ${name}`} onClick={() => props.onDeleteLayout(name)}>×</button>
                </div>
              ))}
              <form
                class="cockpit-layouts__save"
                onSubmit={(e) => {
                  e.preventDefault()
                  const name = layoutName.trim()
                  if (name === '') return
                  props.onSaveLayout(name)
                  setLayoutName('')
                  setLayoutsOpen(false)
                }}
              >
                <input placeholder="Save current as…" value={layoutName} onInput={(e) => setLayoutName((e.target as HTMLInputElement).value)} />
              </form>
            </div>
          ) : null}
        </div>
      </div>
      {menu !== null ? (
        <div class="cockpit-menu" role="menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
          {tabMenuItems(menu.tabId).map((item) => (
            <button type="button" role="menuitem" key={item.label}
              onClick={(e) => { e.stopPropagation(); setMenu(null); item.run() }}>{item.label}</button>
          ))}
        </div>
      ) : null}
      {error && stage.tabs.length > 0 ? <p class="cockpit-error" role="alert">{error}</p> : null}
      {status === 'loading' && <p class="cockpit-placeholder">Connecting to cwd…</p>}
      {status === 'error' && stage.tabs.length === 0 ? (
        <div class="cockpit-placeholder cockpit-placeholder--error" role="alert">
          <p>Could not reach the crossweave daemon.</p>
          {error ? <p class="cockpit-muted">{error}</p> : null}
          <button type="button" onClick={props.onRetry}>Retry</button>
        </div>
      ) : null}
      {status !== 'loading' && status !== 'error' && stage.tabs.length === 0 ? (
        <p class="cockpit-placeholder">
          No open tabs. Press <strong>⌘T</strong> for a new agent, or pick a session in the rail.
        </p>
      ) : null}
      {active ? <div class="cockpit-stage__body">{renderNode(active, active.root)}</div> : null}
    </main>
  )
}

/** A drag handle between two split cells; reports moves as a fraction of the split. */
function Divider({ dir, onDrag }: { dir: SplitDir; onDrag: (delta: number) => void }) {
  return (
    <div
      class={`cockpit-split__divider cockpit-split__divider--${dir}`}
      role="separator"
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        e.preventDefault()
        const container = (e.currentTarget as HTMLElement).parentElement
        if (!container) return
        const rect = container.getBoundingClientRect()
        const total = dir === 'row' ? rect.width : rect.height
        let last = dir === 'row' ? e.clientX : e.clientY
        // Listened on the window, not the 4px handle: a drag leaves the handle at once,
        // and a release outside it (or outside the window) must still end the drag —
        // listeners left behind by a missed pointerup made the next drag count twice.
        const move = (ev: PointerEvent): void => {
          const now = dir === 'row' ? ev.clientX : ev.clientY
          if (total > 0 && now !== last) onDrag((now - last) / total)
          last = now
        }
        const end = (): void => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', end)
          window.removeEventListener('pointercancel', end)
          window.removeEventListener('blur', end)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', end)
        window.addEventListener('pointercancel', end)
        window.addEventListener('blur', end)
      }}
    />
  )
}
