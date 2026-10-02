import { CrossweaveError } from '../../../../src/core/errors.js'
import {
  applyPreset, focusPane, LAYOUT_PRESETS, movePaneToTab, neighbourPane, placeBeside, toggleSync, toggleZoom,
  type Direction, type LayoutNode, type LayoutPreset, type PaneRef, type SplitDir, type StageState, type Tab,
} from './layout'

/**
 * `cw pane …`: what a shell command may ask the window to do with its panes. The caller is
 * UNAUTHENTICATED — any process of the user reaches the daemon socket, an AI agent in a
 * session that may have been prompt-injected included — so this is where the safety is: a
 * closed list of kinds (nothing that types into a pane, reads its output or kills a session),
 * strict validation of every parameter, and the person's yes for whatever is more than
 * arranging what is already on screen (close, synchronize on, open a URL, open a file).
 *
 * Pure over a stage: it returns the new stage, the answer, and the side effects the view must
 * perform (opening a shell, closing a pane), so the rules are tested without a window.
 */

/** No request may take the window past this many panes. */
export const MAX_PANES = 20

const ASK_TIMEOUT_MS = 45_000
const MAX_URL = 2000
const MAX_PATH = 500

export type PaneEffect =
  | { type: 'openShell'; sessionId: string; tabId: string; paneId: string; dir: SplitDir }
  | { type: 'closePane'; tabId: string; paneId: string; pane: PaneRef }

export interface PaneOutcome {
  answer: unknown
  /** The stage after the request, when it changed one. */
  stage?: StageState
  effects: PaneEffect[]
  /** What the window shows so a change cannot happen unseen. */
  toast?: string
  /** The person was asked and said yes: the view re-runs against the latest layout without asking again. */
  asked?: boolean
}

export interface PaneEnv {
  stage: StageState
  sessions: ReadonlyArray<{ id: string; name: string }>
  /** The confirmation dialog; resolves true only when the person chose the action. */
  ask: (q: { title: string; body: string; danger?: boolean; confirmLabel: string }) => Promise<boolean>
  /** No answer by then is a refusal; below the CLI's own timeout. */
  askTimeoutMs?: number
}

const invalid = (message: string): CrossweaveError => new CrossweaveError('PANE_INVALID', message)
const notFound = (message: string): CrossweaveError => new CrossweaveError('PANE_NOT_FOUND', message)

function paramsOf(p: unknown): Record<string, unknown> {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw invalid('Parameters must be an object')
  return p as Record<string, unknown>
}

function countPanes(node: LayoutNode): number {
  return node.type === 'pane' ? 1 : node.children.reduce((n, c) => n + countPanes(c), 0)
}
const totalPanes = (stage: StageState): number => stage.tabs.reduce((n, t) => n + countPanes(t.root), 0)

function leavesOf(node: LayoutNode): Array<{ id: string; pane: PaneRef }> {
  return node.type === 'pane' ? [{ id: node.id, pane: node.pane }] : node.children.flatMap(leavesOf)
}

function activeTabOf(stage: StageState): Tab {
  const tab = stage.tabs.find((t) => t.id === stage.activeTabId) ?? stage.tabs[0]
  if (tab === undefined) throw notFound('No tab is open')
  return tab
}

/** A pane by id anywhere in the window, or the focused pane of the shown tab. */
function resolvePane(stage: StageState, paneId: unknown): { tab: Tab; id: string; pane: PaneRef } {
  if (paneId !== undefined) {
    if (typeof paneId !== 'string' || paneId === '' || paneId.length > 100) throw invalid('paneId must be an id from pane.list')
    for (const tab of stage.tabs) {
      const hit = leavesOf(tab.root).find((l) => l.id === paneId)
      if (hit) return { tab, id: hit.id, pane: hit.pane }
    }
    throw notFound(`No such pane: ${paneId}`)
  }
  const tab = activeTabOf(stage)
  const hit = leavesOf(tab.root).find((l) => l.id === tab.focusedPaneId) ?? leavesOf(tab.root)[0]
  if (hit === undefined) throw notFound('No pane is open')
  return { tab, id: hit.id, pane: hit.pane }
}

function sessionIdOf(pane: PaneRef): string | undefined {
  return pane.kind === 'browser' ? undefined : pane.sessionId
}

function label(pane: PaneRef, names: ReadonlyMap<string, string>): string {
  if (pane.kind === 'browser') return `the browser pane (${pane.url})`
  const name = names.get(pane.sessionId) ?? pane.sessionId
  return pane.kind === 'terminal' ? `a terminal in ${name}` : pane.kind === 'file' ? `${pane.path} in ${name}` : pane.kind === 'changes' ? `the changes of ${name}` : pane.kind === 'debug' ? `the debug bundle of ${name}` : name
}

async function confirm(env: PaneEnv, q: { title: string; body: string; danger?: boolean; confirmLabel: string }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), env.askTimeoutMs ?? ASK_TIMEOUT_MS) })
  const yes = await Promise.race([env.ask(q).catch(() => false), timeout])
  if (timer !== undefined) clearTimeout(timer)
  // Anything but an explicit yes — a no, no answer in time, a dialog that failed — is a refusal.
  if (yes !== true) throw new CrossweaveError('PANE_DENIED', 'The person did not allow it')
}

function httpUrl(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_URL) throw invalid('url must be an http or https address')
  let u: URL
  try { u = new URL(value) } catch { throw invalid('url must be an http or https address') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw invalid('url must be an http or https address')
  return value
}

/** Relative to the session's worktree, no way up or out: the file pane's own containment check is the second wall. */
function relativePath(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PATH || value.includes('\0')) throw invalid('path must be a file inside the session')
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) throw invalid('path must stay inside the session\'s worktree')
  return value
}

const DIRECTIONS: readonly Direction[] = ['left', 'right', 'up', 'down']

export async function runPaneRequest(env: PaneEnv, kind: string, params: unknown): Promise<PaneOutcome> {
  const { stage } = env
  const names = new Map(env.sessions.map((s) => [s.id, s.name]))
  let asked = false
  const done = (o: Partial<PaneOutcome> & { answer: unknown }): PaneOutcome => ({ effects: [], ...(asked ? { asked: true } : {}), ...o })
  const check = async (q: Parameters<typeof confirm>[1]): Promise<void> => { asked = true; await confirm(env, q) }

  switch (kind) {
    case 'pane.list': {
      return done({
        answer: {
          activeTabId: stage.activeTabId,
          tabs: stage.tabs.map((tab, i) => ({
            id: tab.id, index: i + 1, title: tab.title, active: tab.id === stage.activeTabId, sync: tab.sync === true,
            zoomedPaneId: tab.zoomedPaneId ?? null,
            panes: leavesOf(tab.root).map((l) => ({
              id: l.id, kind: l.pane.kind, focused: l.id === tab.focusedPaneId,
              ...(sessionIdOf(l.pane) !== undefined ? { session: names.get(sessionIdOf(l.pane) as string) ?? null } : {}),
              ...(l.pane.kind === 'browser' ? { url: l.pane.url } : {}),
              ...(l.pane.kind === 'file' ? { path: l.pane.path } : {}),
            })),
          })),
        },
      })
    }

    case 'pane.split': {
      const p = paramsOf(params)
      if (p.direction !== 'right' && p.direction !== 'down') throw invalid('direction must be right or down')
      const target = resolvePane(stage, p.paneId)
      const sessionId = sessionIdOf(target.pane)
      if (sessionId === undefined) throw invalid('A browser pane has no session to open a shell in')
      if (totalPanes(stage) >= MAX_PANES) throw new CrossweaveError('PANE_LIMIT', `The window already has ${MAX_PANES} panes`)
      return done({
        answer: { ok: true },
        effects: [{ type: 'openShell', sessionId, tabId: target.tab.id, paneId: target.id, dir: p.direction === 'right' ? 'row' : 'column' }],
        toast: `A shell command split ${label(target.pane, names)}`,
      })
    }

    case 'pane.select': {
      const p = paramsOf(params)
      if ((p.paneId === undefined) === (p.direction === undefined)) throw invalid('Give either paneId or direction')
      if (p.paneId !== undefined) {
        const t = resolvePane(stage, p.paneId)
        return done({ answer: { paneId: t.id }, stage: { ...focusPane(stage, t.tab.id, t.id), activeTabId: t.tab.id } })
      }
      if (typeof p.direction !== 'string' || !DIRECTIONS.includes(p.direction as Direction)) throw invalid('direction must be left, right, up or down')
      const from = resolvePane(stage, undefined)
      const next = neighbourPane(from.tab, from.id, p.direction as Direction)
      if (next === undefined) throw notFound(`No pane ${p.direction} of the focused one`)
      return done({ answer: { paneId: next }, stage: focusPane(stage, from.tab.id, next) })
    }

    case 'pane.zoom': {
      const p = paramsOf(params ?? {})
      const t = resolvePane(stage, p.paneId)
      return done({ answer: { ok: true }, stage: toggleZoom(stage, t.tab.id, t.id) })
    }

    case 'pane.layout': {
      const p = paramsOf(params)
      if (typeof p.preset !== 'string' || !LAYOUT_PRESETS.includes(p.preset as LayoutPreset)) throw invalid(`preset must be one of ${LAYOUT_PRESETS.join(', ')}`)
      const tab = activeTabOf(stage)
      return done({ answer: { ok: true }, stage: applyPreset(stage, tab.id, p.preset as LayoutPreset), toast: `A shell command changed the layout (${p.preset})` })
    }

    case 'pane.move': {
      const p = paramsOf(params)
      const from = resolvePane(stage, p.paneId === undefined ? '' : p.paneId)
      let to: Tab | undefined
      if (typeof p.tab === 'number') {
        if (!Number.isInteger(p.tab) || p.tab < 1) throw invalid('tab must be a tab id or a number from 1')
        to = stage.tabs[p.tab - 1]
      } else if (typeof p.tab === 'string' && p.tab !== '') {
        to = stage.tabs.find((t) => t.id === p.tab)
      } else {
        throw invalid('tab must be a tab id or a number from 1')
      }
      if (to === undefined) throw notFound('No such tab')
      const next = movePaneToTab(stage, from.tab.id, from.id, to.id)
      if (next === stage) return done({ answer: { moved: false } })
      return done({ answer: { moved: true }, stage: next, toast: `A shell command moved a pane to tab ${stage.tabs.indexOf(to) + 1}` })
    }

    case 'pane.sync': {
      const p = paramsOf(params ?? {})
      const mode = p.mode === undefined ? 'toggle' : p.mode
      if (mode !== 'on' && mode !== 'off' && mode !== 'toggle') throw invalid('mode must be on, off or toggle')
      const tab = activeTabOf(stage)
      const now = tab.sync === true
      const want = mode === 'toggle' ? !now : mode === 'on'
      if (want === now) return done({ answer: { sync: now } })
      // Typing then goes to several shells at once: the person says yes. Turning it off needs none.
      if (want) {
        const n = leavesOf(tab.root).filter((l) => l.pane.kind === 'session' || l.pane.kind === 'terminal').length
        await check({ title: 'Type into several panes at once?', body: `A shell command asked to synchronize this tab: everything you type will go to all ${n} terminal panes until you turn it off.`, confirmLabel: 'Synchronize' })
      }
      return done({ answer: { sync: want }, stage: toggleSync(stage, tab.id), ...(want ? { toast: 'Synchronize panes is on (a shell command asked)' } : {}) })
    }

    case 'pane.close': {
      const p = paramsOf(params ?? {})
      const t = resolvePane(stage, p.paneId)
      await check({ title: 'Close this pane?', body: `A shell command asked to close ${label(t.pane, names)}.`, danger: true, confirmLabel: 'Close pane' })
      return done({ answer: { ok: true }, effects: [{ type: 'closePane', tabId: t.tab.id, paneId: t.id, pane: t.pane }] })
    }

    case 'pane.openUrl': {
      const p = paramsOf(params)
      const url = httpUrl(p.url)
      if (totalPanes(stage) >= MAX_PANES) throw new CrossweaveError('PANE_LIMIT', `The window already has ${MAX_PANES} panes`)
      await check({ title: 'Open this page in a pane?', body: `A shell command asked to open ${url.slice(0, 200)}.`, confirmLabel: 'Open' })
      return done({ answer: { ok: true }, stage: placeBeside(stage, { kind: 'browser', url }, new URL(url).hostname) })
    }

    case 'pane.openFile': {
      const p = paramsOf(params)
      const path = relativePath(p.path)
      if (typeof p.session !== 'string' || p.session === '') throw invalid('session must name a session')
      const session = env.sessions.find((s) => s.name === p.session)
      if (session === undefined) throw notFound(`No such session: ${p.session.slice(0, 60)}`)
      if (totalPanes(stage) >= MAX_PANES) throw new CrossweaveError('PANE_LIMIT', `The window already has ${MAX_PANES} panes`)
      await check({ title: 'Open this file in a pane?', body: `A shell command asked to open ${path} from ${session.name}.`, confirmLabel: 'Open' })
      return done({ answer: { ok: true }, stage: placeBeside(stage, { kind: 'file', sessionId: session.id, path }, path.split('/').pop() ?? path) })
    }

    default:
      throw new CrossweaveError('BRIDGE_UNSUPPORTED_KIND', `The cockpit does not serve ${String(kind).slice(0, 60)}`)
  }
}

/** The kinds the renderer serves (`pane.ping` is answered by the main process). */
export const PANE_KINDS: readonly string[] = [
  'pane.list', 'pane.split', 'pane.select', 'pane.zoom', 'pane.layout', 'pane.move', 'pane.sync', 'pane.close', 'pane.openUrl', 'pane.openFile',
]
