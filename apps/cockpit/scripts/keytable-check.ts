#!/usr/bin/env bun
/**
 * The key-table (tmux prefix) on the running app over CDP: the hint, prefix then %, the prefix twice
 * typing a literal Ctrl-a into the shell, prefix then z, an unbound key, and no interception in an
 * input. Run with the app open on a project with a running session (scratch HOME wise):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/keytable-check.ts
 */
const R = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const { DaemonClient } = await import(`${R}/src/client/rpc-client.ts`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as any[]
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const call = (method: string, params: any = {}) => {
  const id = ++seq
  return new Promise<any>((res) => {
    const on = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data))
      if (m.id !== id) return
      ws.removeEventListener('message', on)
      res(m)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const ev = async (x: string) => (await call('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value
for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('.cockpit-pane')`)); i++) await sleep(250)
const report: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => { report.push(`${ok ? 'ok ' : 'BAD'} ${name}${extra ? ' — ' + extra : ''}`) }

const panes = (): Promise<number> => ev(`document.querySelectorAll('.cockpit-stage__body:not([hidden]) .cockpit-pane').length`)
const focusTerm = (): Promise<unknown> => ev(`document.querySelector('.cockpit-stage__body:not([hidden]) .cockpit-pane .xterm-helper-textarea')?.focus()`)
const key = async (k: string, opts: { ctrl?: boolean; shift?: boolean; code?: string; vk?: number } = {}): Promise<void> => {
  const mods = (opts.ctrl ? 2 : 0) | (opts.shift ? 8 : 0)
  const base = { key: k, code: opts.code ?? (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k), windowsVirtualKeyCode: opts.vk ?? k.toUpperCase().charCodeAt(0), modifiers: mods, ...(k.length === 1 && !opts.ctrl ? { text: k } : {}) }
  await call('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(250)
}

// listen to the shells to see what reaches them
const client = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
const w = (await client.call('workspace.list')) as any[]
let out = ''
client.onNotification((m: string, p: any) => { if ((m === 'session.data' || m === 'terminal.data') && typeof p.chunk === 'string') out += p.chunk })
const name = String(await ev(`document.querySelector('.cockpit-stage__body:not([hidden]) .cockpit-pane').getAttribute('aria-label')`)).split(' ')[0]!
await client.call('session.attach', { workspaceId: w[0].id, idOrName: name })
await sleep(500)

await focusTerm()
check('starts with one pane', (await panes()) === 1)

// 1. the prefix shows the hint and is swallowed
out = ''
await key('a', { ctrl: true })
check('the hint appears while the prefix is held', (await ev(`document.querySelector('.cockpit-keyhint') !== null`)) === true)
check('the prefix did not reach the shell', !out.includes('\x01'))

// 2. % splits right
await key('%', { shift: true, code: 'Digit5', vk: 53 })
await sleep(600)
check('prefix then % splits the pane', (await panes()) === 2)
check('the hint is gone afterwards', (await ev(`document.querySelector('.cockpit-keyhint')`)) === null)

const terms = (await client.call('terminal.list', { workspaceId: w[0].id })) as any[]
for (const t of terms) await client.call('terminal.attach', { workspaceId: w[0].id, terminalId: t.terminalId })
await sleep(500)
// 3. the prefix twice types Ctrl-a: it moves to the start of the line, so an X typed after it lands in front
await focusTerm()
await sleep(200)
out = ''
await call('Input.insertText', { text: 'echo abc' })
await sleep(300)
await key('a', { ctrl: true })
await key('a', { ctrl: true })
await call('Input.insertText', { text: 'X' })
await sleep(200)
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await sleep(1200)
const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
check('the prefix twice types a literal Ctrl-a (the line ran as "Xecho abc")', plain.includes('Xecho'), JSON.stringify(plain.slice(-400)) + ' bytes=' + JSON.stringify([...out.matchAll(/\x01/g)].length))

// 4. z zooms (the tab body is marked zoomed)
await focusTerm()
await key('a', { ctrl: true })
await key('z')
await sleep(500)
check('prefix then z zooms', (await ev(`!!document.querySelector('.cockpit-stage__body.is-zoomed')`)) === true)
await focusTerm()
await key('a', { ctrl: true })
await key('z')
await sleep(300)

// 5. an unbound key does nothing and leaves prefix mode
await focusTerm()
await key('a', { ctrl: true })
await key('q')
check('an unbound key leaves prefix mode', (await ev(`document.querySelector('.cockpit-keyhint')`)) === null)

// 6. never intercepted outside a terminal: in the sidebar filter box Ctrl-a is left alone
await ev(`document.querySelector('.cockpit-sidebar input[type=search], .cockpit-sidebar input')?.focus()`)
await key('a', { ctrl: true })
check('no prefix mode while an input has the keyboard', (await ev(`document.querySelector('.cockpit-keyhint')`)) === null)

console.log(report.join('\n'))
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
