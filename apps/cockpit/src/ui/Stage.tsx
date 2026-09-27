import { useCallback, useRef, useState } from 'preact/hooks'
import { useDismiss } from './useDismiss'
import type { ListedSession } from '../host/cockpit-api'
import type { LayoutNode, PaneRef, SplitDir, StageState, Tab } from '../lib/layout'
import { sessionSource, terminalSource, type InAppOpener } from '../lib/pane-source'
import type { SessionColor } from '../lib/colors'
import { XtermPane } from './XtermPane'
import { useProjectApi } from './project-context'
import { AgentMark, DiffIcon, FileIcon, GlobeIcon, MoreIcon, PanelRightIcon, PlusIcon, SidebarIcon, TerminalIcon } from './icons'

export type StageStatus = 'loading' | 'ready' | 'empty' | 'error' | 'welcome'

export type StageProps = {
  stage: StageState
  sessions: ListedSession[]
  status: StageStatus
  error: string | null
  /** Try attaching the workspace again after a failure. */
  onRetry: () => void
  /** What a session pane shows under its terminal while its shell is closed. */
  launchFor?: (sessionId: string, focused: boolean) => preact.JSX.Element | null
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
  /** The sidebar is hidden: the tab strip makes room for the traffic lights. */
  sidebarHidden: boolean
  onToggleSidebar: () => void
  /** The tab strip's `+`: a new session in the active project. */
  onNewTab: () => void
  /** The right-hand toggle: the focused session's Changes pane. */
  onToggleChanges: () => void
  /**
   * False while this project's view is kept alive off the stage: nothing in it takes
   * the keyboard, so returning to it focuses its pane again.
   */
  shown?: boolean
}

function paneLabel(pane: PaneRef, names: ReadonlyMap<string, string>, titles: ReadonlyMap<string, string>): string {
  switch (pane.kind) {
    // What the agent last said, as in Deck; the session name until it said anything.
    case 'session': return titles.get(pane.sessionId) ?? names.get(pane.sessionId) ?? pane.sessionId
    case 'terminal': return `${names.get(pane.sessionId) ?? pane.sessionId} · shell`
    case 'file': return pane.path.split('/').pop() ?? pane.path
    case 'browser': return pane.url.replace(/^https?:\/\//, '')
    case 'changes': return `${names.get(pane.sessionId) ?? pane.sessionId} · changes`
  }
}

function firstPane(node: LayoutNode): PaneRef {
  return node.type === 'pane' ? node.pane : firstPane(node.children[0]!)
}

function paneCount(node: LayoutNode): number {
  return node.type === 'pane' ? 1 : node.children.reduce((n, c) => n + paneCount(c), 0)
}

type TabMenu = { tabId: string; x: number; y: number }
type PaneMenu = { tabId: string; paneId: string; pane: PaneRef; x: number; y: number }

function PaneKindIcon({ pane, agents }: { pane: PaneRef; agents: ReadonlyMap<string, string | null | undefined> }) {
  switch (pane.kind) {
    case 'session': return <AgentMark agent={agents.get(pane.sessionId) ?? null} />
    case 'terminal': return <TerminalIcon />
    case 'file': return <FileIcon />
    case 'browser': return <GlobeIcon />
    case 'changes': return <DiffIcon />
  }
}

export function Stage(props: StageProps) {
  const { stage, sessions, status, error, paneAttachEpoch = 0, paneAttachBumps = {} } = props
  const api = useProjectApi()
  const names = new Map(sessions.map((s) => [s.id, s.name]))
  const titles = new Map(sessions.flatMap((s) => (s.latestWords ? [[s.id, s.latestWords] as const] : [])))
  const agents = new Map(sessions.map((s) => [s.id, s.agent]))
  const [paneMenu, setPaneMenu] = useState<PaneMenu | null>(null)
  const active = stage.tabs.find((t) => t.id === stage.activeTabId) ?? null
  const [menu, setMenu] = useState<TabMenu | null>(null)
  const [layoutsOpen, setLayoutsOpen] = useState(false)
  const [layoutName, setLayoutName] = useState('')
  const dragTab = useRef<string | null>(null)

  const tabLabel = (tab: Tab): string => {
    const n = paneCount(tab.root)
    return `${paneLabel(firstPane(tab.root), names, titles)}${n > 1 ? ` +${n - 1}` : ''}`
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
    const focused = tab.focusedPaneId === node.id && props.shown !== false
    return (
      <div
        key={node.id}
        class={focused ? 'cockpit-pane is-focused' : 'cockpit-pane'}
        aria-label={paneLabel(pane, names, titles)}
        onMouseDown={() => { if (!focused) props.onFocusPane(tab.id, node.id) }}
        // No title bar on a pane, as in Deck: split and close live here and on ⌘D,
        // ⌘⇧D and ⌘W.
        onContextMenu={(e) => {
          e.preventDefault()
          setPaneMenu({ tabId: tab.id, paneId: node.id, pane, x: e.clientX, y: e.clientY })
        }}
      >
        {pane.kind === 'session' ? (() => {
          const launch = props.launchFor?.(pane.sessionId, focused) ?? null
          return (
            <>
              <XtermPane
                key={`${pane.sessionId}:${paneAttachEpoch}:${paneAttachBumps[pane.sessionId] ?? 0}`}
                source={sessionSource(api, pane.sessionId, props.inApp)}
                // The stopped bar takes the keyboard while there is no shell to type to.
                focused={focused && launch === null}
              />
              {launch}
            </>
          )
        })() : pane.kind === 'terminal' ? (
          <XtermPane
            key={`terminal:${pane.terminalId}:${paneAttachEpoch}`}
            source={terminalSource(api, pane.terminalId, pane.sessionId, props.inApp)}
            focused={focused}
          />
        ) : (
          props.renderSurface?.(pane, focused, { tabId: tab.id, paneId: node.id }) ?? null
        )}
      </div>
    )
  }

  const layoutsRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const paneMenuRef = useRef<HTMLDivElement>(null)
  const closePaneMenu = useCallback(() => setPaneMenu(null), [])
  useDismiss(paneMenu !== null, closePaneMenu, paneMenuRef)
  const closeLayouts = useCallback(() => setLayoutsOpen(false), [])
  const closeMenu = useCallback(() => setMenu(null), [])
  useDismiss(layoutsOpen, closeLayouts, layoutsRef)
  useDismiss(menu !== null, closeMenu, menuRef)

  /** Roving focus over the tab strip: ←/→ move and activate, Home/End jump. */
  const onTabKey = (e: KeyboardEvent, index: number): void => {
    const last = stage.tabs.length - 1
    const to = e.key === 'ArrowRight' ? Math.min(index + 1, last)
      : e.key === 'ArrowLeft' ? Math.max(index - 1, 0)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : -1
    if (to !== -1) {
      e.preventDefault()
      const target = stage.tabs[to]
      if (target) {
        props.onActivateTab(target.id)
        const strip = (e.currentTarget as HTMLElement).parentElement
        ;(strip?.querySelectorAll<HTMLElement>('[role="tab"]')[to])?.focus()
      }
      return
    }
    const tab = stage.tabs[index]
    if (!tab) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      props.onActivateTab(tab.id)
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault()
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setMenu({ tabId: tab.id, x: box.left, y: box.bottom })
    }
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
      <div class={`cockpit-tabs${props.sidebarHidden ? ' has-traffic' : ''}`} role="tablist" aria-label="Tabs">
        {props.sidebarHidden ? (
          <button type="button" class="cockpit-iconbtn" title="Show sidebar (⌘\\)" aria-label="Show sidebar" onClick={props.onToggleSidebar}>
            <SidebarIcon />
          </button>
        ) : null}
        {stage.tabs.map((tab, index) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === stage.activeTabId}
            tabIndex={tab.id === stage.activeTabId ? 0 : -1}
            onKeyDown={(e) => onTabKey(e, index)}
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
            {tab.pinned ? <span class="cockpit-tab__pin" title="Pinned: stays first, and Close Others leaves it">pinned</span> : null}
            {(() => {
              const lead = firstPane(tab.root)
              const color = lead.kind !== 'browser' ? props.colorById?.[lead.sessionId] : undefined
              return (
                <>
                  <PaneKindIcon pane={lead} agents={agents} />
                  {color ? <span class="cockpit-dot" style={{ background: `var(--cw-${color})` }} aria-hidden="true" /> : null}
                </>
              )
            })()}
            <span class="cockpit-tab__title">{tabLabel(tab)}</span>
            {!tab.pinned ? (
              <button type="button" class="cockpit-tab__close" aria-label={`Close tab ${tabLabel(tab)}`}
                onClick={(e) => { e.stopPropagation(); props.onCloseTab(tab.id) }}>×</button>
            ) : null}
          </div>
        ))}
        <button type="button" class="cockpit-iconbtn cockpit-tabs__new" title="New session (⌘T)" aria-label="New session" onClick={props.onNewTab}>
          <PlusIcon />
        </button>
        <div class="cockpit-tabs__spacer" />
        <div class="cockpit-layouts" ref={layoutsRef}>
          <button type="button" class="cockpit-iconbtn" title="Layouts" aria-label="Layouts" aria-expanded={layoutsOpen}
            onClick={(e) => { e.stopPropagation(); setLayoutsOpen(!layoutsOpen) }}>
            <MoreIcon />
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
        <button type="button" class="cockpit-iconbtn" title="Changes of the focused session" aria-label="Changes" onClick={props.onToggleChanges}>
          <PanelRightIcon />
        </button>
      </div>
      {paneMenu !== null ? (
        <div class="cockpit-menu" role="menu" ref={paneMenuRef} style={{ left: `${paneMenu.x}px`, top: `${paneMenu.y}px` }}>
          {paneMenu.pane.kind !== 'browser' ? (
            <>
              <button type="button" role="menuitem"
                onClick={() => { props.onSplit(paneMenu.tabId, paneMenu.paneId, 'row', paneMenu.pane); setPaneMenu(null) }}>Split right<kbd>⌘D</kbd></button>
              <button type="button" role="menuitem"
                onClick={() => { props.onSplit(paneMenu.tabId, paneMenu.paneId, 'column', paneMenu.pane); setPaneMenu(null) }}>Split down<kbd>⌘⇧D</kbd></button>
            </>
          ) : null}
          <button type="button" role="menuitem"
            onClick={() => { props.onClosePane(paneMenu.tabId, paneMenu.paneId, paneMenu.pane); setPaneMenu(null) }}>Close pane<kbd>⌘W</kbd></button>
        </div>
      ) : null}
      {menu !== null ? (
        <div class="cockpit-menu" role="menu" ref={menuRef} style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
          {tabMenuItems(menu.tabId).map((item) => (
            <button type="button" role="menuitem" key={item.label}
              onClick={(e) => { e.stopPropagation(); setMenu(null); item.run() }}>{item.label}</button>
          ))}
        </div>
      ) : null}
      {status === 'loading' && <p class="cockpit-placeholder">Connecting to cwd…</p>}
      {status === 'error' && stage.tabs.length === 0 ? (
        <div class="cockpit-placeholder cockpit-placeholder--error" role="alert">
          <p>Could not reach the crossweave daemon.</p>
          {error ? <p class="cockpit-muted">{error}</p> : null}
          <button type="button" class="cockpit-btn" onClick={props.onRetry}>Retry</button>
        </div>
      ) : null}
      {status !== 'loading' && status !== 'error' && stage.tabs.length === 0 ? (
        <p class="cockpit-placeholder">
          No open tabs. Press <strong>⌘T</strong> for a new session, or pick one in the rail.
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
