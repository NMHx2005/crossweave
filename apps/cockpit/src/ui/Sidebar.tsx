import { useCallback, useRef, useState } from 'preact/hooks'
import type { ListedSession } from '../host/cockpit-api'
import type { AttentionKind } from '../lib/attention'
import { SESSION_COLORS, type SessionColor } from '../lib/colors'
import { agentName, landChip, railOrder, relativeTime, rowState, rowTitle, ROW_STATE_LABEL } from '../lib/rail'
import { formatRailMeta } from '../lib/sessions'
import { AgentMark, CloseIcon, FolderIcon, GearIcon, PlusIcon, SearchIcon, SidebarIcon } from './icons'
import { useDismiss } from './useDismiss'

export type ProjectGroup = {
  projectRoot: string
  name: string
  /** The project on the stage: its rows focus panes; others switch to it first. */
  active: boolean
  sessions: ListedSession[]
  attentionById: Record<string, AttentionKind>
}

export type RowAction = 'open' | 'stop' | 'changes' | 'land' | 'kill'

export type SidebarProps = {
  projects: ProjectGroup[]
  focusedId: string | null
  /** The clock the relative times are measured against (re-rendered every few seconds). */
  now: number
  colorById: Record<string, SessionColor>
  onToggleSidebar: () => void
  onNew: (projectRoot: string) => void
  onOpenProject: () => void
  onCloseProject: (projectRoot: string) => void
  onCommandBar: () => void
  onSettings: () => void
  onSelect: (projectRoot: string, sessionId: string) => void
  onAction: (projectRoot: string, sessionId: string, action: RowAction) => void
  onSetColor: (sessionId: string, color: SessionColor | null) => void
}

type RowMenu = { projectRoot: string; session: ListedSession; x: number; y: number }

const COLLAPSED_KEY = 'cw.collapsed-projects.v1'

function readCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeCollapsed(set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]))
  } catch {
    // a convenience: the next window starts expanded
  }
}

/**
 * The rail, Deck-style: every open project, and under each its sessions as one line
 * that says what is happening (a glyph), what was last said, how long ago, and which
 * agent. A ready or conflicting session carries its land verdict on the row.
 */
export function Sidebar(props: SidebarProps) {
  const { projects, focusedId, now, colorById } = props
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useDismiss(menu !== null, closeMenu, menuRef)

  const toggle = (root: string): void => {
    const next = new Set(collapsed)
    if (next.has(root)) next.delete(root)
    else next.add(root)
    setCollapsed(next)
    writeCollapsed(next)
  }

  const runMenu = (action: RowAction): void => {
    if (!menu) return
    props.onAction(menu.projectRoot, menu.session.id, action)
    setMenu(null)
  }

  return (
    <aside class="cockpit-sidebar" aria-label="Projects and sessions">
      <div class="cockpit-sidebar__top">
        <button type="button" class="cockpit-iconbtn" title="Hide sidebar (⌘\\)" aria-label="Hide sidebar" onClick={props.onToggleSidebar}>
          <SidebarIcon />
        </button>
        <button type="button" class="cockpit-sidebar__new"
          // With no project yet, "New" starts by choosing one.
          onClick={() => { const active = projects.find((p) => p.active); if (active) props.onNew(active.projectRoot); else props.onOpenProject() }}>
          <PlusIcon /> New
        </button>
        <span class="cockpit-sidebar__spring" />
        <button type="button" class="cockpit-iconbtn" title="Command (⌘K)" aria-label="Command" onClick={props.onCommandBar}>
          <SearchIcon />
        </button>
      </div>

      <div class="cockpit-sidebar__projects">
        {projects.map((project) => {
          const isCollapsed = collapsed.has(project.projectRoot)
          const rows = railOrder(project.sessions.filter((s) => s.status !== 'landed'))
          return (
            <section key={project.projectRoot} class={`cockpit-project${project.active ? ' is-active' : ''}`}>
              <div class="cockpit-project__head">
                <button type="button" class="cockpit-project__name" aria-expanded={!isCollapsed}
                  title={project.projectRoot} onClick={() => toggle(project.projectRoot)}>
                  <FolderIcon />
                  <span>{project.name}</span>
                </button>
                <button type="button" class="cockpit-iconbtn cockpit-project__action" title={`New session in ${project.name} (⌘T)`}
                  aria-label={`New session in ${project.name}`} onClick={() => props.onNew(project.projectRoot)}>
                  <PlusIcon />
                </button>
                {!project.active ? (
                  <button type="button" class="cockpit-iconbtn cockpit-project__action" title={`Close ${project.name}`}
                    aria-label={`Close ${project.name}`} onClick={() => props.onCloseProject(project.projectRoot)}>
                    <CloseIcon />
                  </button>
                ) : null}
              </div>
              {!isCollapsed ? (
                <ul class="cockpit-rows">
                  {rows.length === 0 ? (
                    <li class="cockpit-rows__empty">
                      <button type="button" onClick={() => props.onNew(project.projectRoot)}>New session</button>
                    </li>
                  ) : null}
                  {rows.map((session) => {
                    const state = rowState(session)
                    const chip = landChip(project.attentionById[session.id])
                    const when = relativeTime(session.lastActivityAt, now)
                    const color = colorById[session.id]
                    const meta = formatRailMeta(session)
                    return (
                      <li key={session.id}>
                        <div
                          role="button"
                          tabIndex={0}
                          class={`cockpit-row${session.id === focusedId ? ' is-focused' : ''} is-${state}`}
                          title={`${session.name} — ${ROW_STATE_LABEL[state]} · ${agentName(session.agent)}${meta ? ` · ${meta}` : ''}`}
                          onClick={() => props.onSelect(project.projectRoot, session.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              props.onSelect(project.projectRoot, session.id)
                            }
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setMenu({ projectRoot: project.projectRoot, session, x: e.clientX, y: e.clientY })
                          }}
                        >
                          <span class={`cockpit-status cockpit-status--${state}`} aria-label={ROW_STATE_LABEL[state]} />
                          {color ? <span class="cockpit-dot" style={{ background: `var(--cw-${color})` }} aria-hidden="true" /> : null}
                          <span class="cockpit-row__title">{rowTitle(session)}</span>
                          {chip === 'ready' ? (
                            <button type="button" class="cockpit-chip cockpit-chip--ready" title={`Land ${session.name}`}
                              onClick={(e) => { e.stopPropagation(); props.onAction(project.projectRoot, session.id, 'land') }}>land</button>
                          ) : chip === 'conflict' ? (
                            <button type="button" class="cockpit-chip cockpit-chip--conflict" title="See what conflicts"
                              onClick={(e) => { e.stopPropagation(); props.onAction(project.projectRoot, session.id, 'changes') }}>conflict</button>
                          ) : null}
                          {when ? <span class="cockpit-row__when">{when}</span> : null}
                          <AgentMark agent={session.agent} class="cockpit-row__agent" />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </section>
          )
        })}
      </div>

      <div class="cockpit-sidebar__bottom">
        <button type="button" class="cockpit-sidebar__link" onClick={props.onOpenProject}>
          <FolderIcon /> Open project…
        </button>
        <span class="cockpit-sidebar__spring" />
        <button type="button" class="cockpit-iconbtn" title="Settings (⌘,)" aria-label="Settings" onClick={props.onSettings}>
          <GearIcon />
        </button>
      </div>

      {menu !== null ? (
        <div class="cockpit-menu" role="menu" ref={menuRef} style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
          {menu.session.status === 'running' ? (
            <button type="button" role="menuitem" onClick={() => runMenu('stop')}>Close shell</button>
          ) : menu.session.status === 'idle' ? (
            <button type="button" role="menuitem" onClick={() => runMenu('open')}>Open shell</button>
          ) : null}
          <button type="button" role="menuitem" onClick={() => runMenu('changes')}>Changes</button>
          <button type="button" role="menuitem" onClick={() => runMenu('land')}>Land</button>
          <div class="cockpit-menu__swatches" role="group" aria-label="Session color">
            {SESSION_COLORS.map((c) => (
              <button key={c} type="button" role="menuitem" aria-label={c} class="cockpit-swatch" style={{ background: `var(--cw-${c})` }}
                onClick={() => { props.onSetColor(menu.session.id, c); setMenu(null) }} />
            ))}
            <button type="button" role="menuitem" class="cockpit-swatch cockpit-swatch--none" aria-label="No color"
              onClick={() => { props.onSetColor(menu.session.id, null); setMenu(null) }} />
          </div>
          <button type="button" role="menuitem" class="is-danger" onClick={() => runMenu('kill')}>Kill…</button>
        </div>
      ) : null}
    </aside>
  )
}
