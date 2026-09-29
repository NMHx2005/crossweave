#!/usr/bin/env bun
/**
 * The settings page, walked over CDP: it opens from the rail's gear, every section
 * renders, a search finds a row and jumps to it, a change is saved to the settings file
 * on its own, and Esc returns to the pane that was open.
 *
 * Settings are the user's, read through the daemon from `$HOME/.crossweave/settings.json`
 * — so run the app with a scratch HOME (this script reads the same file to prove a save):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/crossweave Cockpit" --remote-debugging-port=9333 &
 *   HOME=/tmp/cwhome COCKPIT_DEBUG_PORT=9333 bun apps/cockpit/scripts/settings-check.ts [screenshot-dir]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9222'
const SHOTS = process.argv[2]
const SETTINGS = join(process.env['HOME'] ?? '', '.crossweave', 'settings.json')
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
const waitFor = async (expr: string, what: string, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await evaluate(expr)) return
    await sleep(100)
  }
  fail(`timed out waiting for ${what}`)
}

for (let i = 0; i < 40 && !(await evaluate(`document.querySelector('.cockpit-pane') !== null`)); i++) await sleep(250)
const panesBefore = await evaluate(`document.querySelectorAll('.cockpit-pane').length`)
if (panesBefore === 0) fail('no pane on the stage to come back to')

// 1. Opens from the gear.
await evaluate(`document.querySelector('button[aria-label="Settings"]').click()`)
await waitFor(`document.querySelector('.cockpit-settings-page') !== null`, 'the settings page')
ok('opens from the gear')

// 2. Every section renders something.
const sections: string[] = await evaluate(`[...document.querySelectorAll('.cockpit-settings-nav__item')].map((b) => b.textContent)`)
if (sections.length < 7) fail(`only ${sections.length} sections in the navigation`)
for (const title of sections) {
  await evaluate(`[...document.querySelectorAll('.cockpit-settings-nav__item')].find((b) => b.textContent === ${JSON.stringify(title)}).click()`)
  await sleep(250)
  const heading = await evaluate(`document.querySelector('.cockpit-settings-content h2')?.textContent`)
  const rows = await evaluate(`document.querySelectorAll('.cockpit-settings-content [data-setting]').length`)
  if (heading !== title) fail(`section ${title} shows heading ${heading}`)
  if (rows === 0) fail(`section ${title} rendered no rows`)
  await shot(`section-${title.toLowerCase()}`)
}
ok(`all ${sections.length} sections render (${sections.join(', ')})`)

// 3. Search, then jump to the row.
await evaluate(`(() => { const i = document.querySelector('.cockpit-settings-nav__search'); i.value = 'cursor'; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
await waitFor(`document.querySelector('.cockpit-settings-results') !== null`, 'search results')
await shot('search')
const hit = await evaluate(`[...document.querySelectorAll('.cockpit-settings-results__row')].map((b) => b.textContent)`)
if (!hit.some((t: string) => t.startsWith('Cursor'))) fail(`search for "cursor" found ${JSON.stringify(hit)}`)
await evaluate(`[...document.querySelectorAll('.cockpit-settings-results__row')].find((b) => b.textContent.startsWith('Cursor')).click()`)
await waitFor(`document.querySelector('[data-setting="terminal-cursor"].is-target') !== null`, 'the searched row to be highlighted', 3000)
ok('a search hit opens its section and marks the row')

// 4. A change saves itself.
await evaluate(`[...document.querySelectorAll('.cockpit-settings-nav__item')].find((b) => b.textContent === 'Appearance').click()`)
await sleep(200)
const clickSize = (label: string): Promise<unknown> =>
  evaluate(`[...document.querySelectorAll('[data-setting="appearance-text-size"] button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`)
await clickSize('Large')
await sleep(1500)
const saved = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : ''
if (!/"textSize":\s*"large"/.test(saved)) fail(`the change was not written to ${SETTINGS}: ${saved.slice(0, 200)}`)
ok('a change is written to the settings file on its own (no Save button)')
await clickSize('Default')
await sleep(1500)
if (/"textSize":\s*"large"/.test(readFileSync(SETTINGS, 'utf8'))) fail('resetting the text size was not saved')
ok('and so is putting it back')

// 5. Esc returns to the pane.
await evaluate(`document.querySelector('.cockpit-settings-page').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await waitFor(`document.querySelector('.cockpit-settings-page') === null`, 'the page to close')
const panesAfter = await evaluate(`document.querySelectorAll('.cockpit-pane').length`)
if (panesAfter !== panesBefore) fail(`panes ${panesBefore} before, ${panesAfter} after`)
ok(`Esc closes it and the ${panesAfter} pane(s) are still there`)

console.log(report.join('\n'))
process.exit(0)
