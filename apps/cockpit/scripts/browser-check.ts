#!/usr/bin/env bun
/**
 * `cw browser` against the RUNNING cockpit, over CDP + the real bridge: a pane is off until the person
 * flips the switch, reads are redacted and marked untrusted, control needs its level, a non-http address
 * is refused, and `eval` (which always asks) is refused when nobody answers. Also proves the webview guest
 * still has no Node. Run OUTSIDE the sandbox with the app open on a project (scratch HOME wise):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/browser-check.ts
 */
import { existsSync, readFileSync } from 'node:fs'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const page = `<!doctype html><title>fixture</title><body>
<h1>Fixture heading</h1><button id="b">go</button><input id="i"><div id="mirror"></div>
<script>
console.log('hello ?token=abc123&page=2')
document.getElementById('b').addEventListener('click', () => console.log('clicked'))
document.getElementById('i').addEventListener('input', (e) => { document.getElementById('mirror').textContent = 'typed:' + e.target.value })
fetch('/missing?apikey=zzz')
</script>`
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => (new URL(req.url).pathname === '/' || new URL(req.url).pathname === '/other' ? new Response(page, { headers: { 'content-type': 'text/html' } }) : new Response('nope', { status: 404 })) })
const base = `http://127.0.0.1:${server.port}`

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>
const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const cdp = (sock: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> => {
  const id = ++seq
  return new Promise((resolve) => {
    const on = (e: MessageEvent): void => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown }
      if (m.id !== id) return
      sock.removeEventListener('message', on)
      resolve(m.result)
    }
    sock.addEventListener('message', on)
    sock.send(JSON.stringify({ id, method, params }))
  })
}
const ev = async (x: string): Promise<any> => (await cdp(ws, 'Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.value
const report: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => { report.push(`${ok ? 'ok ' : 'BAD'} ${name}${extra ? ' — ' + extra : ''}`) }

function cw(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([process.execPath, `${REPO}/src/cli/index.ts`, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env })
  return (async () => ({ out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text(), code: await proc.exited }))()
}
const dialog = (): Promise<string | null> => ev(`document.querySelector('.cockpit-confirm')?.innerText ?? null`)
const clickDialog = (label: string): Promise<unknown> => ev(`[...document.querySelectorAll('.cockpit-confirm button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`)
const level = (label: 'Off' | 'Read' | 'Control'): Promise<unknown> => ev(`[...document.querySelectorAll('.cockpit-stage__body:not([hidden]) .cockpit-browser__level')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`)
const json = (s: string): any[] => s.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

for (let i = 0; i < 40 && !(await ev(`document.querySelector('.cockpit-pane') !== null`)); i++) await sleep(250)

// 0. Open the fixture in a Browser pane (a layout command that asks, and we answer).
const opening = cw('pane', 'open', '--url', `${base}/`)
for (let i = 0; i < 60 && (await dialog()) === null; i++) await sleep(100)
await clickDialog('Open')
await opening
for (let i = 0; i < 80 && !(await ev(`document.querySelector('.cockpit-stage__body:not([hidden]) .cockpit-browser__level:not([disabled])') !== null`)); i++) await sleep(250)
check('the pane appears with its switch enabled', await ev(`document.querySelector('.cockpit-browser__level:not([disabled])') !== null`))

// 1. Off by default.
const list = await cw('browser', 'list')
check('list shows the pane at off', list.code === 0 && json(list.out)[0]?.level === 'off', list.out.trim())
const off = await cw('browser', 'console')
check('console is refused while the pane is off', off.code === 1 && /BROWSER_PANE_OFF/.test(off.err), off.err.trim())

// 2. Read.
await level('Read')
await sleep(1500)
await ev(`document.querySelector('webview')?.reload()`)
await sleep(2500)
const con = await cw('browser', 'console')
const rows = con.code === 0 ? json(con.out) : []
check('console shows the page log with the token redacted, marked untrusted', rows.some((r) => r.text === 'hello ?token=[redacted]&page=2' && r.untrusted === true), con.out.trim() || con.err.trim())
const net = await cw('browser', 'network', '--failed')
const netRows = net.code === 0 ? json(net.out) : []
check('network --failed shows the 404 with the key redacted and no headers', netRows.some((r) => /missing\?apikey=\[redacted\]/.test(r.url) && r.status === 404) && !/header/i.test(net.out), net.out.trim() || net.err.trim())
const dom = await cw('browser', 'dom')
check('dom returns the rendered text', dom.code === 0 && /Fixture heading/.test(dom.out) && /"untrusted":true/.test(dom.out))
const shot = await cw('browser', 'shot')
const shotPath = shot.out.trim()
check('shot prints a PNG path under .crossweave/shots', shot.code === 0 && shotPath.includes('/.crossweave/shots/') && existsSync(shotPath) && readFileSync(shotPath).subarray(1, 4).toString() === 'PNG', shotPath)
const denied = await cw('browser', 'click', '#b')
check('read level cannot click', denied.code === 1 && /BROWSER_PANE_OFF/.test(denied.err))

// 3. Control on localhost: no dialog.
await level('Control')
await sleep(500)
const click = await cw('browser', 'click', '#b')
check('click runs on localhost without asking', click.code === 0 && (await dialog()) === null, click.err.trim())
const typed = await cw('browser', 'type', '#i', 'abc')
await sleep(300)
const dom2 = await cw('browser', 'dom')
check('type reaches the page', typed.code === 0 && /typed:abc/.test(dom2.out), typed.err.trim())
const con2 = await cw('browser', 'console', '--level', 'info')
check('the click was seen by the page', json(con2.out).some((r) => r.text === 'clicked'))
const bad = await cw('browser', 'navigate', 'file:///etc/passwd')
check('a non-http address is refused', bad.code === 1 && /BROWSER_BAD_URL/.test(bad.err), bad.err.trim())
const badSel = await cw('browser', 'click', '#nope')
check('an unknown selector is BROWSER_BAD_SELECTOR', badSel.code === 1 && /BROWSER_BAD_SELECTOR/.test(badSel.err))

// 4. eval always asks; with nobody answering it is refused after the window (~20 s), and nothing ran.
const evalStart = Date.now()
const evalRun = await cw('browser', 'eval', 'document.title')
check('unanswered eval is refused, not run', evalRun.code === 1 && /BROWSER_NEEDS_CONFIRM/.test(evalRun.err), `${evalRun.err.trim()} after ${Date.now() - evalStart} ms`)

// 5. Off again forgets everything.
await level('Off')
await sleep(500)
const after = await cw('browser', 'console')
check('off refuses again', after.code === 1 && /BROWSER_PANE_OFF/.test(after.err))

// 6. The guest is still locked down: no Node in the page.
const guest = targets.find((t) => t.type === 'webview') ?? ((await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as typeof targets).find((t) => t.type === 'webview')
if (guest === undefined) check('a webview target exists to inspect', false)
else {
  const g = new WebSocket(guest.webSocketDebuggerUrl)
  await new Promise((r) => g.addEventListener('open', r))
  const probe = (await cdp(g, 'Runtime.evaluate', { expression: `typeof require + ',' + typeof process + ',' + typeof window.cockpit`, returnByValue: true })).result.value
  check('the webview has no require, process or cockpit bridge', probe === 'undefined,undefined,undefined', String(probe))
  g.close()
}

server.stop(true)
console.log(report.join('\n'))
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
