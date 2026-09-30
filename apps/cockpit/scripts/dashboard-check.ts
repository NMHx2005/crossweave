#!/usr/bin/env bun
/**
 * The settings Dashboard, walked over CDP against a real daemon: it shows the projects and their sessions, proposes what to free,
 * every action asks first (Esc closes only the dialog, not the settings page), and a confirmed action really removes the session.
 *
 * DESTRUCTIVE by design — it deletes sessions of the project it is pointed at. Only run it against a scratch repo and a scratch HOME,
 * seeded with sessions named `done-1`, `done-2` (ended, worktree kept), `old-empty` (clean) and `old-unlanded` (unlanded work, idle):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/tmp/scratch-repo "…/crossweave Cockpit" --remote-debugging-port=9333 &
 *   COCKPIT_DEBUG_PORT=9333 bun apps/cockpit/scripts/dashboard-check.ts [screenshot-dir]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9222'
const SHOTS = process.argv[2]
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const report: string[] = []
const fail = (m: string): never => { console.error(report.join('\n')); console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (m: string): void => { report.push(`ok  ${m}`) }

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
const page = targets.find((t) => t.type === 'page')
if (!page) fail(`no page on port ${PORT}`)
const ws = new WebSocket(page!.webSocketDebuggerUrl)
await new Promise((resolve) => ws.addEventListener('open', resolve))
let seq = 0
const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  const id = ++seq
  return new Promise((resolve) => {
    const on = (e: MessageEvent): void => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: unknown }
      if (msg.id !== id) return
      ws.removeEventListener('message', on)
      if (msg.error) fail(`${method}: ${JSON.stringify(msg.error)}`)
      resolve(msg.result)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evaluate = async (expression: string): Promise<any> =>
  (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
const shot = async (name: string): Promise<void> => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const r = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data as string, 'base64'))
}
const waitFor = async (expr: string, what: string, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await evaluate(expr)) return
    await sleep(100)
  }
  fail(`timed out waiting for ${what}`)
}
const click = (selector: string, text: string, within = 'document'): Promise<unknown> =>
  evaluate(`[...${within}.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`)
const sessionRow = (name: string): string => `[...document.querySelectorAll('[data-session]')].find((r) => r.querySelector('.cockpit-dash__name')?.textContent === ${JSON.stringify(name)})`

await evaluate('location.reload()')
await sleep(1500)
for (let i = 0; i < 40 && !(await evaluate(`document.querySelector('.cockpit-pane') !== null`)); i++) await sleep(250)

// 1. Opens on the Dashboard and the figures arrive.
await evaluate(`document.querySelector('button[aria-label="Settings"]').click()`)
await waitFor(`document.querySelector('.cockpit-settings-page') !== null`, 'the settings page')
await click('.cockpit-settings-nav__item', 'Dashboard')
await waitFor(`document.querySelectorAll('.cockpit-stat').length === 4`, 'the four overview tiles')
await waitFor(`!document.body.textContent.includes('measuring…')`, 'disk to be measured', 30000)
await shot('dashboard')
ok('the overview and every disk figure arrive')

const suggestions: number = await evaluate(`document.querySelectorAll('[data-suggestion]').length`)
if (suggestions < 2) fail(`expected several suggestions, saw ${suggestions}`)
ok(`${suggestions} suggestions are proposed`)

// 2. The unlanded proposal warns; cancelling changes nothing.
const unlandedBtn = `[...document.querySelectorAll('[data-suggestion] .cockpit-btn--danger')][0]`
if (!(await evaluate(`${unlandedBtn} !== undefined`))) fail('no dangerous proposal for the unlanded session')
await evaluate(`${unlandedBtn}.click()`)
await waitFor(`document.querySelector('.cockpit-confirm') !== null`, 'the confirmation')
const label: string = await evaluate(`document.querySelector('.cockpit-confirm .cockpit-btn--danger').textContent`)
if (label !== 'Delete and lose the work') fail(`the unlanded confirmation says "${label}"`)
const inside: boolean = await evaluate(`(() => { const r = document.querySelector('.cockpit-confirm').getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })()`)
if (!inside) fail('the dialog is not fully inside the window')
await shot('confirm-unlanded')
await evaluate(`document.querySelector('.cockpit-confirm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await waitFor(`document.querySelector('.cockpit-confirm') === null`, 'Esc to close the dialog')
if (!(await evaluate(`document.querySelector('.cockpit-settings-page') !== null`))) fail('Esc closed the whole settings page, not just the dialog')
ok('the unlanded warning names the loss; Esc closes only the dialog')

// 3. Clean up removes the ended sessions.
if (!(await evaluate(`${sessionRow('done-1')} !== undefined`))) fail('the seed has no done-1 session')
await click('[data-suggestion] .cockpit-btn', 'Clean up')
await waitFor(`document.querySelector('.cockpit-confirm') !== null`, 'the clean-up confirmation')
await click('.cockpit-confirm .cockpit-btn', 'Clean up')
await waitFor(`${sessionRow('done-1')} === undefined && ${sessionRow('done-2')} === undefined`, 'the ended sessions to disappear', 20000)
await waitFor(`document.body.textContent.includes('Cleaned up')`, 'the result notice')
await shot('after-cleanup')
ok('Clean up removes the ended sessions and says so')

// 4. Deleting one session from the list.
await evaluate(`${sessionRow('old-empty')}?.querySelector('.cockpit-btn')?.click()`)
await waitFor(`document.querySelector('.cockpit-confirm') !== null`, 'the delete confirmation')
const plain: string = await evaluate(`document.querySelector('.cockpit-confirm .cockpit-btn--danger').textContent`)
if (plain !== 'Delete') fail(`a session with nothing to lose says "${plain}"`)
await click('.cockpit-confirm .cockpit-btn', 'Delete')
await waitFor(`${sessionRow('old-empty')} === undefined`, 'the session to disappear', 20000)
ok('Delete removes a session after asking')

// 5. Narrow window: nothing spills sideways.
await call('Emulation.setDeviceMetricsOverride', { width: 720, height: 800, deviceScaleFactor: 1, mobile: false })
await sleep(400)
const spill: boolean = await evaluate(`document.documentElement.scrollWidth > innerWidth + 1 || document.querySelector('.cockpit-settings-content').scrollWidth > document.querySelector('.cockpit-settings-content').clientWidth + 1`)
await shot('narrow')
await call('Emulation.clearDeviceMetricsOverride')
if (spill) fail('the dashboard scrolls sideways in a narrow window')
ok('a narrow window does not scroll sideways')

console.log(report.join('\n'))
process.exit(0)
