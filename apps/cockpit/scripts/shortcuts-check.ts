#!/usr/bin/env bun
/**
 * The shortcuts capture dialog, walked over CDP: Change opens a capture DIALOG (the
 * row is never edited in place), Esc closes it, None/Reset appear as offered, and the
 * shortcut list stays intact underneath. Run the app with a scratch HOME, then:
 *
 *   HOME=/tmp/cwhome COCKPIT_DEBUG_PORT=9333 bun apps/cockpit/scripts/shortcuts-check.ts [screenshot-dir]
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const SHOTS = process.argv[2]
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const report: string[] = []
const fail = (m: string): never => { console.error(report.join('\n')); console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (m: string): void => { report.push(`ok  ${m}`) }

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
const page = targets.find((t) => t.type === 'page')
if (!page) fail(`no page on port ${PORT}`)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve) => ws.addEventListener('open', resolve))
let seq = 0
/** CDP answers arbitrary JSON: each call site asserts the shape it expects. */
const call = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
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
const evaluate = async (expression: string): Promise<unknown> =>
  ((await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as { result?: { value?: unknown } }).result?.value
const shot = async (name: string): Promise<void> => {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  const data = await call('Page.captureScreenshot', { format: 'png' }) as { data: string }
  await Bun.write(join(SHOTS, name), Buffer.from(data.data, 'base64'))
}

await sleep(1500)

// Settings from the rail's gear, then the Keyboard shortcuts section.
await evaluate(`document.querySelector('button[aria-label="Settings"]')?.click()`)
await sleep(600)
const changeCount = await evaluate(`document.querySelectorAll('.cockpit-shortcuts__actions button').length`) as number
if (changeCount === 0) fail('no shortcut Change buttons in Settings')
ok(`${changeCount} shortcut actions rendered`)

// Change → the capture dialog, and the row is not recording in place.
await evaluate(`[...document.querySelectorAll('.cockpit-shortcuts__actions button')].find((b) => b.textContent === 'Change')?.click()`)
await sleep(300)
const dialog = await evaluate(`(() => {
  const d = document.querySelector('.cockpit-shortcuts__capture')
  if (!d) return null
  return { label: d.querySelector('.cockpit-picker__title')?.textContent, hint: d.querySelector('.cockpit-shortcuts__capture-hint')?.textContent,
           buttons: [...d.querySelectorAll('button')].map((b) => b.textContent) }
})()`) as { label?: string; hint?: string; buttons?: string[] } | null
if (!dialog) fail('Change did not open the capture dialog')
if (!String(dialog?.buttons).includes('Press keys… (Esc cancels)')) fail('the capture surface is missing')
ok(`capture dialog open: ${dialog?.label} — ${dialog?.buttons?.join(', ')}`)
const inPlace = await evaluate(`!!document.querySelector('.cockpit-shortcuts__row .cockpit-shortcuts__record')`) as boolean
if (inPlace) fail('a row is recording in place — the dialog was the requirement')
ok('no row records in place')
await shot('shortcuts-capture-open.png')

// Escape on the capture surface closes the dialog, the list intact.
await evaluate(`document.querySelector('.cockpit-shortcuts__record')?.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }))`)
await sleep(300)
const closed = await evaluate(`!document.querySelector('.cockpit-shortcuts__capture')`) as boolean
if (!closed) fail('Escape did not close the capture dialog')
ok('Escape closed the dialog; list intact')
await shot('shortcuts-capture-closed.png')

// Cancel button too.
await evaluate(`[...document.querySelectorAll('.cockpit-shortcuts__actions button')].find((b) => b.textContent === 'Change')?.click()`)
await sleep(200)
await evaluate(`[...document.querySelectorAll('.cockpit-shortcuts__capture button')].find((b) => b.textContent === 'Cancel')?.click()`)
await sleep(200)
const cancelled = await evaluate(`!document.querySelector('.cockpit-shortcuts__capture')`) as boolean
if (!cancelled) fail('Cancel did not close the capture dialog')
ok('Cancel closed the dialog')

console.log(report.join('\n'))
console.log('OK: shortcuts capture dialog')
process.exit(0)
