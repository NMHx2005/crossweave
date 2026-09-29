#!/usr/bin/env bun
/**
 * `cw pane` against the RUNNING cockpit, over CDP: layout-only commands change the window and toast;
 * the ones that are more than layout (close, sync on, open --url/--file) wait for the person and do
 * NOTHING when refused or unanswered; invalid requests never reach the person. Run with the app open
 * on a project that has a running session (scratch HOME wise):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/pane-check.ts
 */
const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  const id = ++seq
  return new Promise((resolve) => {
    const on = (e: MessageEvent): void => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown }
      if (m.id !== id) return
      ws.removeEventListener('message', on)
      resolve(m.result)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const ev = async (x: string): Promise<any> => (await call('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.value
for (let i = 0; i < 40 && !(await ev(`document.querySelector('.cockpit-pane') !== null`)); i++) await sleep(250)

const report: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => { report.push(`${ok ? 'ok ' : 'BAD'} ${name}${extra ? ' — ' + extra : ''}`) }

/** Run `cw pane …` in the project; resolves with its output and exit status. */
function cw(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([process.execPath, `${REPO}/src/cli/index.ts`, 'pane', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env })
  return (async () => ({ out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text(), code: await proc.exited }))()
}
const panes = (): Promise<number> => ev(`document.querySelectorAll('.cockpit-stage__body:not([hidden]) .cockpit-pane').length`)
const dialog = (): Promise<string | null> => ev(`document.querySelector('.cockpit-confirm')?.innerText ?? null`)
const click = (label: string): Promise<unknown> => ev(`[...document.querySelectorAll('.cockpit-confirm button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`)
const waitDialog = async (): Promise<string | null> => { for (let i = 0; i < 60; i++) { const d = await dialog(); if (d) return d; await sleep(100) } return null }

// 1. list
const list = await cw('list')
check('list shows the tab and its pane', list.code === 0 && /^TAB 1\t/m.test(list.out) && /PANE\t/.test(list.out), JSON.stringify(list.out.split('\n')[0]))
const before = await panes()

// 2. split and layout are layout: no dialog, a toast
const split = await cw('split', 'right')
await sleep(1200)
check('split opens a shell without asking', split.code === 0 && (await panes()) === before + 1 && (await dialog()) === null)
check('and says so in a toast', /split/i.test(String(await ev(`document.querySelector('.cockpit-toast')?.innerText ?? ''`))))
const layout = await cw('layout', 'even-vertical')
await sleep(600)
check('layout arranges the tab', layout.code === 0)
const select = await cw('select', 'up')
check('select moves focus (or says there is nothing there)', select.code === 0 || /PANE_NOT_FOUND/.test(select.err))
const zoom = await cw('zoom')
await sleep(400)
check('zoom toggles', zoom.code === 0 && (await ev(`!!document.querySelector('.cockpit-stage__body.is-zoomed')`)) === true)
await cw('zoom')

// 3. invalid: rejected by the CLI or the window, never shown to the person
const badLayout = await cw('layout', 'spiral')
check('a bad preset is refused before anything is sent', badLayout.code === 1 && /INVALID_ARGUMENTS/.test(badLayout.err))
const noSuch = await cw('select', 'p_does_not_exist')
check('an unknown pane id is PANE_NOT_FOUND', noSuch.code === 1 && /PANE_NOT_FOUND/.test(noSuch.err), noSuch.err.trim())
const badUrl = cw('open', '--url', 'file:///etc/passwd')
const badUrlRes = await badUrl
check('a non-http URL is refused and never shows a dialog', badUrlRes.code === 1 && /PANE_INVALID/.test(badUrlRes.err) && (await dialog()) === null, badUrlRes.err.trim())
const badPath = await cw('open', '--file', '../../etc/passwd', '--session', 'alpha')
check('a path leaving the worktree is refused', badPath.code === 1 && /PANE_INVALID|PANE_NOT_FOUND/.test(badPath.err), badPath.err.trim())

// 4. close asks: refuse first, then allow
const count = await panes()
const closing = cw('close')
const shown = await waitDialog()
check('close waits for the person and says what', shown !== null && /close/i.test(shown), JSON.stringify(shown?.split('\n')[0]))
await click('Cancel')
const closed = await closing
check('refusing changes nothing and the command reports PANE_DENIED', closed.code === 1 && /PANE_DENIED/.test(closed.err) && (await panes()) === count, closed.err.trim())
const closing2 = cw('close')
await waitDialog()
await click('Close pane')
const closed2 = await closing2
await sleep(800)
check('allowing closes the pane', closed2.code === 0 && (await panes()) === count - 1)

// 5. sync on asks; off never does
const syncOn = cw('sync', 'on')
const syncDialog = await waitDialog()
check('sync on asks, naming the effect', syncDialog !== null && /synchroniz/i.test(syncDialog))
await click('Cancel')
check('refused: sync stays off', (await syncOn).code === 1 && (await ev(`document.querySelector('.cockpit-sync-banner')`)) === null)

// 6. open --url asks and names the address
const open = cw('open', '--url', 'http://localhost:3999/test')
const openDialog = await waitDialog()
check('open --url asks and names the address', openDialog !== null && openDialog.includes('http://localhost:3999/test'))
await click('Cancel')
const openRes = await open
check('refused: no pane was opened', openRes.code === 1 && /PANE_DENIED/.test(openRes.err))

// 7. nobody answering is a refusal, not an approval
const silent = cw('close')
await waitDialog()
await sleep(200)
await ev(`document.querySelector('.cockpit-confirm')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
const silentRes = await silent
check('dismissing the dialog is a refusal', silentRes.code === 1 && /PANE_DENIED/.test(silentRes.err))

console.log(report.join('\n'))
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
