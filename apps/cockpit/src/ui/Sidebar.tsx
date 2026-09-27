import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { ListedSession } from '../host/cockpit-api'
import type { AttentionKind } from '../lib/attention'
import { SESSION_COLORS, type SessionColor } from '../lib/colors'
import { sessionNameError } from '../lib/quick-picker'
import { agentName, clampMenu, gitBadge, jumpTargets, landChip, railOrder, relativeTime, rowState, rowTitle, ROW_STATE_LABEL, visibleRows } from '../lib/rail'
import { formatRailMeta } from '../lib/sessions'
import { projectUsage, usageLabel } from '../lib/usage'
import type { ModelPrice } from '../../../../src/core/settings.js'
import { AgentMark, ChevronIcon, CloseIcon, FolderIcon, GearIcon, PlusIcon, SearchIcon, SidebarIcon } from './icons'
import { useDismiss } from './useDismiss'

export type ProjectGroup = {
  projectRoot: string
  /** What the rail calls it: the display name from the project menu, else the folder's. */
  name: string
  /** The project on the stage: its rows focus panes; others switch to it first. */
  active: boolean
  sessions: ListedSession[]
  attentionById: Record<string, AttentionKind>
  color?: SessionColor
  hideEnded?: boolean
  /** Sessions whose agent finished and that the user has not looked at since. */
  doneIds?: readonly string[]
}

export type RowAction = 'open' | 'stop' | 'changes' | 'land' | 'kill' | 'delete' | 'terminal'

export type ProjectAction =
  | 'new' | 'terminal-here' | 'land-all' | 'gc' | 'toggle-ended' | 'settings' | 'close' | 'move-up' | 'move-down'

export type FolderHow = 'reveal' | 'editor' | 'copy'

/** What is being renamed in place; lifted to the app so a menu or a switch can start it. */
export type Renaming =
  | { kind: 'project'; projectRoot: string }
  | { kind: 'session'; projectRoot: string; sessionId: string }
  /** The session's one-line note, edited in place. */
  | { kind: 'note'; projectRoot: string; sessionId: string }

export type SidebarProps = {
  projects: ProjectGroup[]
  focusedId: string | null
  /** The clock the relative times are measured against (re-rendered every few seconds). */
  now: number
  colorById: Record<string, SessionColor>
  /** The filter box's text; rows that do not match it are hidden. */
  query: string
  onQuery: (query: string) => void
  renaming: Renaming | null
  onRenaming: (renaming: Renaming | null) => void
  onToggleSidebar: () => void
  onNew: (projectRoot: string) => void
  onOpenProject: () => void
  onCommandBar: () => void
  onSettings: () => void
  onSelect: (projectRoot: string, sessionId: string) => void
  onAction: (projectRoot: string, sessionId: string, action: RowAction) => void
  onSetColor: (sessionId: string, color: SessionColor | null) => void
  onProjectAction: (projectRoot: string, action: ProjectAction) => void
  onProjectColor: (projectRoot: string, color: SessionColor | null) => void
  /** An empty name puts the folder's name back. */
  onRenameProject: (projectRoot: string, label: string) => void
  /** Resolves to the daemon's refusal, or null once renamed. */
  onRenameSession: (projectRoot: string, sessionId: string, name: string) => Promise<string | null>
  /** '' clears it. Resolves to the daemon's refusal, or null. */
  onSetNote: (projectRoot: string, sessionId: string, note: string) => Promise<string | null>
  /** Drag and drop: `from` goes where `to` is. */
  onReorder: (from: string, to: string) => void
  onFolder: (projectRoot: string, sessionId: string | null, how: FolderHow) => void
  /** Settings → Usage: whether the rail shows tokens / cost, and the user's prices. */
  showUsage: boolean
  prices: Record<string, ModelPrice> | undefined
}

type Menu =
  | { kind: 'row'; projectRoot: string; session: ListedSession; x: number; y: number }
  | { kind: 'project'; project: ProjectGroup; index: number; x: number; y: number }

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
 * that says what is happening (a glyph), what was last said, how long ago, what git
 * holds (files changed, commits to land) and which agent. Right-click a project or a
 * session for everything else; double-click a name to rename it.
 */
export function Sidebar(props: SidebarProps) {
  const { projects, focusedId, now, colorById, query, renaming } = props
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const dragging = useRef<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useDismiss(menu !== null, closeMenu, menuRef)
  const filtering = query.trim() !== ''

  // Opened at the pointer, then moved so a long menu near an edge stays on screen.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el || !menu) return
    const { left, top } = clampMenu(menu.x, menu.y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [menu])

  const toggle = (root: string): void => {
    const next = new Set(collapsed)
    if (next.has(root)) next.delete(root)
    else next.add(root)
    setCollapsed(next)
    writeCollapsed(next)
  }

  const numbers = new Map(jumpTargets(projects, query).slice(0, 9).map((t, i) => [t.sessionId, i + 1]))

  const rowMenu = (action: RowAction): void => {
    if (menu?.kind !== 'row') return
    props.onAction(menu.projectRoot, menu.session.id, action)
    setMenu(null)
  }
  const projectMenu = (action: ProjectAction): void => {
    if (menu?.kind !== 'project') return
    props.onProjectAction(menu.project.projectRoot, action)
    setMenu(null)
  }
  const folder = (projectRoot: string, sessionId: string | null, how: FolderHow): void => {
    props.onFolder(projectRoot, sessionId, how)
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

      {projects.length > 0 ? (
        <div class="cockpit-sidebar__filter">
          <input
            type="search"
            value={query}
            placeholder="Filter sessions"
            aria-label="Filter sessions"
            spellcheck={false}
            onInput={(e) => props.onQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                props.onQuery('')
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
        </div>
      ) : null}

      <div class="cockpit-sidebar__projects">
        {projects.map((project, index) => {
          const rows = railOrder(visibleRows(project.sessions, { hideEnded: project.hideEnded, query }))
          if (filtering && rows.length === 0) return null
          const isCollapsed = !filtering && collapsed.has(project.projectRoot)
          const renamingThis = renaming?.kind === 'project' && renaming.projectRoot === project.projectRoot
          const headUsage = props.showUsage ? usageLabel(projectUsage(project.sessions.map((s) => s.usage)), props.prices) : undefined
          const folderName = baseName(project.projectRoot)
          return (
            <section
              key={project.projectRoot}
              class={`cockpit-project${project.active ? ' is-active' : ''}${dragOver === project.projectRoot ? ' is-drop' : ''}`}
              onDragOver={(e) => {
                if (dragging.current === null || dragging.current === project.projectRoot) return
                e.preventDefault()
                setDragOver(project.projectRoot)
              }}
              onDragLeave={() => setDragOver((d) => (d === project.projectRoot ? null : d))}
              onDrop={(e) => {
                e.preventDefault()
                const from = dragging.current
                dragging.current = null
                setDragOver(null)
                if (from !== null && from !== project.projectRoot) props.onReorder(from, project.projectRoot)
              }}
            >
              <div
                class="cockpit-project__head"
                draggable={!renamingThis}
                onDragStart={(e) => {
                  dragging.current = project.projectRoot
                  e.dataTransfer?.setData('text/plain', project.projectRoot)
                }}
                onDragEnd={() => { dragging.current = null; setDragOver(null) }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ kind: 'project', project, index, x: e.clientX, y: e.clientY })
                }}
              >
                {renamingThis ? (
                  <div class="cockpit-project__name is-editing">
                    <FolderIcon />
                    <InlineRename
                      initial={project.name}
                      label={`Display name for ${folderName}`}
                      validate={(v) => (v.length > 60 ? 'At most 60 characters' : null)}
                      onCommit={(v) => { props.onRenameProject(project.projectRoot, v); props.onRenaming(null); return Promise.resolve(null) }}
                      onCancel={() => props.onRenaming(null)}
                    />
                  </div>
                ) : (
                  <button type="button" class="cockpit-project__name" aria-expanded={!isCollapsed}
                    title={`${project.projectRoot}${project.name !== folderName ? ` (${project.name})` : ''} — double-click to rename, right-click for more`}
                    onClick={() => toggle(project.projectRoot)}
                    onDblClick={() => props.onRenaming({ kind: 'project', projectRoot: project.projectRoot })}>
                    <ChevronIcon class="cockpit-project__twisty" />
                    <span class="cockpit-project__icon" style={project.color ? { color: `var(--cw-${project.color})` } : undefined}><FolderIcon /></span>
                    <span>{project.name}</span>
                    {headUsage ? <span class="cockpit-project__usage" title={headUsage.title}>{headUsage.text}</span> : null}
                  </button>
                )}
                <button type="button" class="cockpit-iconbtn cockpit-project__action" title={`New session in ${project.name} (⌘T)`}
                  aria-label={`New session in ${project.name}`} onClick={() => props.onNew(project.projectRoot)}>
                  <PlusIcon />
                </button>
                <button type="button" class="cockpit-iconbtn cockpit-project__action" title={`Close ${project.name} (its sessions keep running)`}
                  aria-label={`Close ${project.name}`} onClick={() => props.onProjectAction(project.projectRoot, 'close')}>
                  <CloseIcon />
                </button>
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
                    const color = project.active ? colorById[session.id] : undefined
                    const meta = formatRailMeta(session)
                    const git = gitBadge(session.git)
                    // The project folder's figures belong to the project heading, not to one row.
                    const used = props.showUsage && !session.usage?.folder ? usageLabel(session.usage, props.prices) : undefined
                    const n = numbers.get(session.id)
                    const renamingRow = renaming?.kind === 'session' && renaming.sessionId === session.id
                    const notingRow = renaming?.kind === 'note' && renaming.sessionId === session.id
                    return (
                      <li key={session.id}>
                        <div
                          role="button"
                          tabIndex={0}
                          class={`cockpit-row${session.id === focusedId ? ' is-focused' : ''} is-${state}`}
                          title={`${session.name} — ${ROW_STATE_LABEL[state]} · ${agentName(session.agent)}${meta ? ` · ${meta}` : ''}${git ? ` · ${git.title}` : ''}${n ? ` · ⌘${n}` : ''}`}
                          onClick={() => { if (!renamingRow && !notingRow) props.onSelect(project.projectRoot, session.id) }}
                          onDblClick={() => props.onRenaming({ kind: 'session', projectRoot: project.projectRoot, sessionId: session.id })}
                          onKeyDown={(e) => {
                            if (renamingRow || notingRow) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              props.onSelect(project.projectRoot, session.id)
                            } else if (e.key === 'F2') {
                              e.preventDefault()
                              props.onRenaming({ kind: 'session', projectRoot: project.projectRoot, sessionId: session.id })
                            }
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setMenu({ kind: 'row', projectRoot: project.projectRoot, session, x: e.clientX, y: e.clientY })
                          }}
                        >
                          <span class={`cockpit-status cockpit-status--${state}`} aria-label={ROW_STATE_LABEL[state]} />
                          {color ? <span class="cockpit-dot" style={{ background: `var(--cw-${color})` }} aria-hidden="true" /> : null}
                          {renamingRow ? (
                            <InlineRename
                              initial={session.name}
                              label={`New name for ${session.name}`}
                              validate={sessionNameError}
                              onCommit={async (v) => {
                                if (v === session.name) { props.onRenaming(null); return null }
                                const problem = await props.onRenameSession(project.projectRoot, session.id, v)
                                if (problem === null) props.onRenaming(null)
                                return problem
                              }}
                              onCancel={() => props.onRenaming(null)}
                            />
                          ) : notingRow ? (
                            <InlineRename
                              initial={session.note ?? ''}
                              label={`Note for ${session.name}`}
                              validate={(v) => (v.length > 120 ? 'At most 120 characters' : null)}
                              onCommit={async (v) => {
                                if (v === (session.note ?? '')) { props.onRenaming(null); return null }
                                const problem = await props.onSetNote(project.projectRoot, session.id, v)
                                if (problem === null) props.onRenaming(null)
                                return problem
                              }}
                              onCancel={() => props.onRenaming(null)}
                            />
                          ) : (
                            <span class={`cockpit-row__title${session.note ? ' is-note' : ''}`}>{rowTitle(session)}</span>
                          )}
                          {chip === 'ready' ? (
                            <button type="button" class="cockpit-chip cockpit-chip--ready" title={`Land ${session.name}`}
                              onClick={(e) => { e.stopPropagation(); props.onAction(project.projectRoot, session.id, 'land') }}>land</button>
                          ) : chip === 'conflict' ? (
                            <button type="button" class="cockpit-chip cockpit-chip--conflict" title="See what conflicts"
                              onClick={(e) => { e.stopPropagation(); props.onAction(project.projectRoot, session.id, 'changes') }}>conflict</button>
                          ) : null}
                          {project.doneIds?.includes(session.id) ? (
                            <span class="cockpit-row__done" title="Finished — not looked at yet" aria-label="finished">✓</span>
                          ) : null}
                          {git ? (
                            <span class="cockpit-row__git" aria-label={git.title}>
                              {git.changed ? <span class="cockpit-row__changed">{git.changed}</span> : null}
                              {git.ahead ? <span class="cockpit-row__ahead">{git.ahead}</span> : null}
                            </span>
                          ) : null}
                          {used ? <span class="cockpit-row__usage" title={used.title}>{used.text}</span> : null}
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
        {filtering && projects.every((p) => visibleRows(p.sessions, { hideEnded: p.hideEnded, query }).length === 0) ? (
          <p class="cockpit-sidebar__nomatch">No session matches “{query.trim()}”.</p>
        ) : null}
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

      {menu?.kind === 'row' ? (
        <div class="cockpit-menu" role="menu" ref={menuRef} style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
          {menu.session.status === 'running' ? (
            <button type="button" role="menuitem" onClick={() => rowMenu('stop')}>Close shell</button>
          ) : menu.session.status === 'idle' ? (
            <button type="button" role="menuitem" onClick={() => rowMenu('open')}>Open shell</button>
          ) : null}
          {menu.session.status !== 'landed' && menu.session.worktreePath ? (
            <button type="button" role="menuitem" onClick={() => rowMenu('terminal')}>New terminal here</button>
          ) : null}
          <button type="button" role="menuitem" onClick={() => {
            if (menu.kind === 'row') props.onRenaming({ kind: 'session', projectRoot: menu.projectRoot, sessionId: menu.session.id })
            setMenu(null)
          }}>Rename…<kbd>F2</kbd></button>
          <button type="button" role="menuitem" onClick={() => {
            if (menu.kind === 'row') props.onRenaming({ kind: 'note', projectRoot: menu.projectRoot, sessionId: menu.session.id })
            setMenu(null)
          }}>{menu.session.note ? 'Edit note…' : 'Set note…'}</button>
          {menu.session.note ? (
            <button type="button" role="menuitem" onClick={() => {
              if (menu.kind === 'row') void props.onSetNote(menu.projectRoot, menu.session.id, '')
              setMenu(null)
            }}>Clear note</button>
          ) : null}
          {/* A session in the project folder has no branch: nothing to diff or land. */}
          {menu.session.branch !== null ? (
            <>
              <div class="cockpit-menu__sep" role="separator" />
              <button type="button" role="menuitem" onClick={() => rowMenu('changes')}>Changes</button>
              <button type="button" role="menuitem" onClick={() => rowMenu('land')}>Land</button>
            </>
          ) : null}
          {menu.session.worktreePath ? (
            <>
              <div class="cockpit-menu__sep" role="separator" />
              <button type="button" role="menuitem" onClick={() => folder(menu.projectRoot, menu.session.id, 'editor')}>Open in editor</button>
              <button type="button" role="menuitem" onClick={() => folder(menu.projectRoot, menu.session.id, 'reveal')}>Reveal in Finder</button>
              <button type="button" role="menuitem" onClick={() => folder(menu.projectRoot, menu.session.id, 'copy')}>Copy path</button>
            </>
          ) : null}
          {projects.find((p) => p.projectRoot === menu.projectRoot)?.active ? (
            <div class="cockpit-menu__swatches" role="group" aria-label="Session color">
              {SESSION_COLORS.map((c) => (
                <button key={c} type="button" role="menuitem" aria-label={c} class="cockpit-swatch" style={{ background: `var(--cw-${c})` }}
                  onClick={() => { props.onSetColor(menu.session.id, c); setMenu(null) }} />
              ))}
              <button type="button" role="menuitem" class="cockpit-swatch cockpit-swatch--none" aria-label="No color"
                onClick={() => { props.onSetColor(menu.session.id, null); setMenu(null) }} />
            </div>
          ) : null}
          <div class="cockpit-menu__sep" role="separator" />
          {menu.session.status !== 'dead' && menu.session.status !== 'landed' ? (
            <button type="button" role="menuitem" class="is-danger" onClick={() => rowMenu('kill')}>Kill…</button>
          ) : null}
          <button type="button" role="menuitem" class="is-danger" onClick={() => rowMenu('delete')}>Delete…</button>
        </div>
      ) : null}

      {menu?.kind === 'project' ? (
        <div class="cockpit-menu" role="menu" aria-label={`${menu.project.name} actions`} ref={menuRef} style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
          <button type="button" role="menuitem" onClick={() => projectMenu('new')}>New session…<kbd>⌘T</kbd></button>
          <button type="button" role="menuitem" onClick={() => projectMenu('terminal-here')}>Terminal in project folder</button>
          <div class="cockpit-menu__sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => folder(menu.project.projectRoot, null, 'editor')}>Open in editor</button>
          <button type="button" role="menuitem" onClick={() => folder(menu.project.projectRoot, null, 'reveal')}>Reveal in Finder</button>
          <button type="button" role="menuitem" onClick={() => folder(menu.project.projectRoot, null, 'copy')}>Copy path</button>
          <div class="cockpit-menu__sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => projectMenu('land-all')}>Land all ready</button>
          <button type="button" role="menuitem" onClick={() => projectMenu('gc')}>Clean up ended sessions…</button>
          <button type="button" role="menuitem" onClick={() => projectMenu('toggle-ended')}>
            {menu.project.hideEnded ? 'Show ended sessions' : 'Hide ended sessions'}
          </button>
          <div class="cockpit-menu__sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => {
            if (menu.kind === 'project') props.onRenaming({ kind: 'project', projectRoot: menu.project.projectRoot })
            setMenu(null)
          }}>Rename…</button>
          <div class="cockpit-menu__swatches" role="group" aria-label="Project color">
            {SESSION_COLORS.map((c) => (
              <button key={c} type="button" role="menuitem" aria-label={c} class="cockpit-swatch" style={{ background: `var(--cw-${c})` }}
                onClick={() => { if (menu.kind === 'project') props.onProjectColor(menu.project.projectRoot, c); setMenu(null) }} />
            ))}
            <button type="button" role="menuitem" class="cockpit-swatch cockpit-swatch--none" aria-label="No color"
              onClick={() => { if (menu.kind === 'project') props.onProjectColor(menu.project.projectRoot, null); setMenu(null) }} />
          </div>
          <button type="button" role="menuitem" disabled={menu.index === 0} onClick={() => projectMenu('move-up')}>Move up</button>
          <button type="button" role="menuitem" disabled={menu.index === projects.length - 1} onClick={() => projectMenu('move-down')}>Move down</button>
          <button type="button" role="menuitem" onClick={() => projectMenu('settings')}>Project settings…</button>
          <div class="cockpit-menu__sep" role="separator" />
          <button type="button" role="menuitem" class="is-danger" onClick={() => projectMenu('close')}>Close project</button>
        </div>
      ) : null}
    </aside>
  )
}

/**
 * A name edited where it is shown: Enter or leaving the field saves, Escape cancels.
 * A refusal (bad name, taken, the daemon said no) stays in the field with the reason.
 */
function InlineRename({ initial, label, validate, onCommit, onCancel }: {
  initial: string
  label: string
  validate: (value: string) => string | null
  onCommit: (value: string) => Promise<string | null>
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useLayoutEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const commit = async (): Promise<void> => {
    if (done.current) return
    // The field, not the state: a key handler bound before the last input's re-render
    // would commit the previous value.
    const v = (ref.current?.value ?? value).trim()
    const problem = validate(v)
    if (problem !== null) {
      setError(problem)
      return
    }
    done.current = true
    const refused = await onCommit(v)
    if (refused !== null) {
      done.current = false
      setError(refused)
    }
  }

  return (
    <span class="cockpit-rename">
      <input
        ref={ref}
        value={value}
        aria-label={label}
        aria-invalid={error !== null}
        title={error ?? undefined}
        spellcheck={false}
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
        onInput={(e) => { setValue((e.target as HTMLInputElement).value); setError(null) }}
        onKeyDown={(e) => {
          e.stopPropagation()
          // A composing IME (Vietnamese Telex, …) owns Enter until it commits.
          if (e.isComposing) return
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            done.current = true
            onCancel()
          }
        }}
        onBlur={() => {
          // Leaving a refused name keeps nothing: the old name stays.
          if (error !== null) {
            done.current = true
            onCancel()
          } else void commit()
        }}
      />
      {error !== null ? <span class="cockpit-rename__error" role="alert">{error}</span> : null}
    </span>
  )
}

function baseName(root: string): string {
  return root.split('/').filter((p) => p !== '').pop() ?? root
}
