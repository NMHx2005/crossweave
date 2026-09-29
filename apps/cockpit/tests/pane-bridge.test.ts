import { describe, expect, test } from 'bun:test'
import { CrossweaveError } from '../../../src/core/errors.js'
import { emptyStage, openInNewTab, paneKeys, splitPane, type LayoutNode, type PaneRef, type StageState } from '../src/lib/layout'
import { runPaneRequest, MAX_PANES, type PaneEnv, type PaneOutcome } from '../src/lib/pane-bridge'

const session = (sessionId: string): PaneRef => ({ kind: 'session', sessionId })
const SESSIONS = [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }]

function stageOf(...ids: string[]): StageState {
  let s = emptyStage()
  for (const id of ids) s = openInNewTab(s, session(id), id)
  return s
}
const firstLeaf = (n: LayoutNode): LayoutNode => (n.type === 'pane' ? n : firstLeaf(n.children[0]!))
const leaves = (n: LayoutNode): string[] => (n.type === 'pane' ? [n.id] : n.children.flatMap(leaves))

interface Asked { title: string; body: string; danger?: boolean }
function harness(stage: StageState, answers: boolean[] = []) {
  const asked: Asked[] = []
  const queue = [...answers]
  const env = (over: Partial<PaneEnv> = {}): PaneEnv => ({
    stage,
    sessions: SESSIONS,
    ask: async (q) => { asked.push(q); return queue.length > 0 ? queue.shift()! : true },
    askTimeoutMs: 50,
    ...over,
  })
  const run = (kind: string, params: unknown = {}, over: Partial<PaneEnv> = {}): Promise<PaneOutcome> => runPaneRequest(env(over), kind, params)
  return { asked, run }
}
const codeOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'resolved' } catch (e) { return e instanceof CrossweaveError ? e.code : 'other' } }

describe('pane.list', () => {
  test('lists tabs and panes with ids the window made, which is focused, and session names', async () => {
    const h = harness(stageOf('a', 'b'))
    const r = await h.run('pane.list')
    const answer = r.answer as { tabs: Array<{ id: string; index: number; active: boolean; panes: Array<{ id: string; kind: string; focused: boolean; session?: string }> }> }
    expect(answer.tabs).toHaveLength(2)
    expect(answer.tabs.map((t) => t.index)).toEqual([1, 2])
    expect(answer.tabs[1]!.active).toBe(true)
    expect(answer.tabs[0]!.panes[0]).toMatchObject({ kind: 'session', focused: true, session: 'alpha' })
    expect(r.stage).toBeUndefined() // reading changes nothing
    expect(r.toast).toBeUndefined()
  })

  test('asks nobody anything', async () => {
    const h = harness(stageOf('a'))
    await h.run('pane.list')
    expect(h.asked).toEqual([])
  })
})

describe('pane.split', () => {
  test('asks the view to open a shell beside the focused pane, in that pane\'s session', async () => {
    const s = stageOf('a')
    const h = harness(s)
    const r = await h.run('pane.split', { direction: 'right' })
    expect(r.effects).toEqual([{ type: 'openShell', sessionId: 'a', tabId: s.tabs[0]!.id, paneId: firstLeaf(s.tabs[0]!.root).id, dir: 'row' }])
    expect(r.toast).toMatch(/split/i)
    expect(h.asked).toEqual([]) // no confirmation: an agent can already run a shell
  })

  test('down is a column, and a named pane is the anchor', async () => {
    let s = stageOf('a')
    const tabId = s.tabs[0]!.id
    s = splitPane(s, tabId, firstLeaf(s.tabs[0]!.root).id, 'row', session('b'))
    const second = leaves(s.tabs[0]!.root)[1]!
    const r = await harness(s).run('pane.split', { direction: 'down', paneId: second })
    expect(r.effects).toEqual([{ type: 'openShell', sessionId: 'b', tabId, paneId: second, dir: 'column' }])
  })

  test('a browser pane has no session to open a shell in', async () => {
    const s = openInNewTab(emptyStage(), { kind: 'browser', url: 'http://localhost:3000' }, 'web')
    expect(await codeOf(harness(s).run('pane.split', { direction: 'right' }))).toBe('PANE_INVALID')
  })

  test('refuses a bad direction, an unknown pane, and a full window', async () => {
    const s = stageOf('a')
    expect(await codeOf(harness(s).run('pane.split', { direction: 'sideways' }))).toBe('PANE_INVALID')
    expect(await codeOf(harness(s).run('pane.split', { direction: 'right', paneId: 'nope' }))).toBe('PANE_NOT_FOUND')
    let full = stageOf('a')
    for (let i = 0; i < MAX_PANES; i++) full = splitPane(full, full.tabs[0]!.id, firstLeaf(full.tabs[0]!.root).id, 'row', session('a'))
    expect(paneKeys(full).length).toBeGreaterThanOrEqual(MAX_PANES)
    expect(await codeOf(harness(full).run('pane.split', { direction: 'right' }))).toBe('PANE_LIMIT')
  })
})

describe('layout-only kinds', () => {
  test('select by direction and by id moves focus, asking nothing', async () => {
    let s = stageOf('a')
    const tabId = s.tabs[0]!.id
    s = splitPane(s, tabId, firstLeaf(s.tabs[0]!.root).id, 'row', session('b')) // focus is on the new (right) pane
    const [left, right] = leaves(s.tabs[0]!.root) as [string, string]
    const h = harness(s)
    const byDir = await h.run('pane.select', { direction: 'left' })
    expect(byDir.stage!.tabs[0]!.focusedPaneId).toBe(left)
    const byId = await h.run('pane.select', { paneId: right })
    expect(byId.stage!.tabs[0]!.focusedPaneId).toBe(right)
    expect(h.asked).toEqual([])
  })

  test('select needs exactly one of paneId and direction, and the pane must exist', async () => {
    const s = stageOf('a')
    expect(await codeOf(harness(s).run('pane.select', {}))).toBe('PANE_INVALID')
    expect(await codeOf(harness(s).run('pane.select', { paneId: 'x', direction: 'left' }))).toBe('PANE_INVALID')
    expect(await codeOf(harness(s).run('pane.select', { paneId: 'nope' }))).toBe('PANE_NOT_FOUND')
    expect(await codeOf(harness(s).run('pane.select', { direction: 'up' }))).toBe('PANE_NOT_FOUND') // nothing above a lone pane
  })

  test('zoom toggles the focused (or a named) pane', async () => {
    const s = stageOf('a')
    const r = await harness(s).run('pane.zoom')
    expect(r.stage!.tabs[0]!.zoomedPaneId).toBe(firstLeaf(s.tabs[0]!.root).id)
    const back = await harness(r.stage!).run('pane.zoom')
    expect(back.stage!.tabs[0]!.zoomedPaneId).toBeUndefined()
  })

  test('layout applies a preset from the allowed set and says so', async () => {
    let s = stageOf('a')
    s = splitPane(s, s.tabs[0]!.id, firstLeaf(s.tabs[0]!.root).id, 'row', session('b'))
    const r = await harness(s).run('pane.layout', { preset: 'even-vertical' })
    const root = r.stage!.tabs[0]!.root
    expect(root.type === 'split' && root.dir).toBe('column')
    expect(r.toast).toMatch(/layout/i)
    expect(await codeOf(harness(s).run('pane.layout', { preset: 'spiral' }))).toBe('PANE_INVALID')
  })

  test('move sends a pane to another tab, by id or by 1-based index', async () => {
    let s = stageOf('a', 'b')
    const t1 = s.tabs[0]!.id
    s = splitPane(s, t1, firstLeaf(s.tabs[0]!.root).id, 'row', session('a'))
    const moving = leaves(s.tabs[0]!.root)[1]!
    const byIndex = await harness(s).run('pane.move', { paneId: moving, tab: 2 })
    expect(paneKeys({ tabs: [byIndex.stage!.tabs[1]!], activeTabId: null }).length).toBe(2)
    const byId = await harness(s).run('pane.move', { paneId: moving, tab: s.tabs[1]!.id })
    expect(byId.stage!.tabs.length).toBe(2)
    expect(byIndex.toast).toMatch(/moved/i)
  })

  test('move validates the pane and the tab', async () => {
    const s = stageOf('a', 'b')
    const pane = firstLeaf(s.tabs[0]!.root).id
    expect(await codeOf(harness(s).run('pane.move', { paneId: 'nope', tab: 2 }))).toBe('PANE_NOT_FOUND')
    expect(await codeOf(harness(s).run('pane.move', { paneId: pane, tab: 9 }))).toBe('PANE_NOT_FOUND')
    expect(await codeOf(harness(s).run('pane.move', { paneId: pane, tab: 0 }))).toBe('PANE_INVALID')
    expect(await codeOf(harness(s).run('pane.move', { paneId: pane }))).toBe('PANE_INVALID')
  })
})

describe('what asks the person', () => {
  test('closing a pane asks, marked dangerous, naming the pane; yes closes it', async () => {
    let s = stageOf('a')
    s = splitPane(s, s.tabs[0]!.id, firstLeaf(s.tabs[0]!.root).id, 'row', session('b'))
    const target = leaves(s.tabs[0]!.root)[1]!
    const h = harness(s, [true])
    const r = await h.run('pane.close', { paneId: target })
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]!.danger).toBe(true)
    expect(h.asked[0]!.title).toMatch(/close/i)
    expect(r.effects).toEqual([{ type: 'closePane', tabId: s.tabs[0]!.id, paneId: target, pane: session('b') }])
  })

  test('a refusal changes nothing and is PANE_DENIED', async () => {
    const s = stageOf('a')
    const h = harness(s, [false])
    expect(await codeOf(h.run('pane.close'))).toBe('PANE_DENIED')
  })

  test('no answer in time is a refusal, never an approval', async () => {
    const s = stageOf('a')
    const h = harness(s)
    const never = await codeOf(h.run('pane.close', {}, { ask: () => new Promise<boolean>(() => undefined), askTimeoutMs: 20 }))
    expect(never).toBe('PANE_DENIED')
  })

  test('turning sync ON asks; turning it off and toggling off do not', async () => {
    const s = stageOf('a')
    const on = harness(s, [true])
    const r = await on.run('pane.sync', { mode: 'on' })
    expect(on.asked).toHaveLength(1)
    expect(r.stage!.tabs[0]!.sync).toBe(true)
    const off = harness(r.stage!)
    const r2 = await off.run('pane.sync', { mode: 'off' })
    expect(off.asked).toEqual([])
    expect(r2.stage!.tabs[0]!.sync).toBeUndefined()
    expect(await codeOf(harness(s, [false]).run('pane.sync', { mode: 'toggle' }))).toBe('PANE_DENIED') // toggle to on asks
    expect(await codeOf(harness(s).run('pane.sync', { mode: 'sometimes' }))).toBe('PANE_INVALID')
  })

  test('opening a URL asks, naming it; only http and https are allowed', async () => {
    const s = stageOf('a')
    const h = harness(s, [true])
    const r = await h.run('pane.openUrl', { url: 'http://localhost:3000/app' })
    expect(h.asked[0]!.body).toContain('http://localhost:3000/app')
    expect(r.stage).toBeDefined()
    const opened = r.stage!.tabs[0]!
    expect(JSON.stringify(opened.root)).toContain('"kind":"browser"')
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x', 'localhost:3000', '', 'http://' + 'a'.repeat(3000)]) {
      const hh = harness(s)
      expect(await codeOf(hh.run('pane.openUrl', { url: bad })), bad.slice(0, 30)).toBe('PANE_INVALID')
      expect(hh.asked).toEqual([]) // an invalid request never even reaches the person
    }
  })

  test('opening a file asks, names session and path, and refuses a path that could leave the worktree', async () => {
    const s = stageOf('a')
    const h = harness(s, [true])
    const r = await h.run('pane.openFile', { session: 'alpha', path: 'src/index.ts' })
    expect(h.asked[0]!.body).toContain('alpha')
    expect(h.asked[0]!.body).toContain('src/index.ts')
    expect(JSON.stringify(r.stage!.tabs[0]!.root)).toContain('"kind":"file"')
    for (const bad of ['/etc/passwd', '../secret', 'a/../../b', '', 'x\0y', '~/x']) {
      const hh = harness(s)
      expect(await codeOf(hh.run('pane.openFile', { session: 'alpha', path: bad })), JSON.stringify(bad)).toBe('PANE_INVALID')
      expect(hh.asked).toEqual([])
    }
    expect(await codeOf(harness(s).run('pane.openFile', { session: 'nobody', path: 'x' }))).toBe('PANE_NOT_FOUND')
  })
})

describe('the closed set', () => {
  test('a kind that is not on the list is refused, not passed on', async () => {
    const h = harness(stageOf('a'))
    for (const kind of ['pane.sendKeys', 'pane.run', 'pane.kill', 'pane.readOutput', 'pane', 'browser.open', 'session.kill', '']) {
      expect(await codeOf(h.run(kind, {})), kind).toBe('BRIDGE_UNSUPPORTED_KIND')
    }
  })

  test('parameters that are not an object are refused where they are needed', async () => {
    const s = stageOf('a')
    expect(await codeOf(harness(s).run('pane.split', null))).toBe('PANE_INVALID')
    expect(await codeOf(harness(s).run('pane.layout', 'even-vertical'))).toBe('PANE_INVALID')
  })

  test('with nothing open every kind that needs a pane says so', async () => {
    const h = harness(emptyStage())
    expect(await codeOf(h.run('pane.split', { direction: 'right' }))).toBe('PANE_NOT_FOUND')
    expect(await codeOf(h.run('pane.zoom'))).toBe('PANE_NOT_FOUND')
    expect((await h.run('pane.list')).answer).toMatchObject({ tabs: [] })
  })
})
