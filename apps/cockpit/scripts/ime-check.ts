#!/usr/bin/env bun
/**
 * Vietnamese (Telex-style) composition against the key-table on the RUNNING app, using Chromium's own IME
 * simulation over CDP (`Input.imeSetComposition` + `Input.insertText`): text composed in a terminal pane reaches the shell
 * as UTF-8, and a composing key never runs a key-table command — neither after the prefix nor without it.
 *
 * This is CDP's simulation of the composition events, NOT macOS's Vietnamese input source: it proves the app's listeners
 * behave under composition events, not that every Telex sequence on a real keyboard is right. Run OUTSIDE the sandbox on a
 * scratch project (scratch HOME wise):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/ime-check.ts
 */
const R = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const NAME = `ime-${Date.now() % 100000}`
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
const report: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => { report.push(`${ok ? 'ok ' : 'BAD'} ${name}${extra ? ' — ' + extra : ''}`) }

const client = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
const workspaceId = ((await client.call('workspace.list')) as any[])[0].id
const created = (await client.call('session.new', { workspaceId, name: NAME })) as { id: string }
await client.call('session.start', { workspaceId, idOrName: created.id })
await sleep(2500)
await ev(`[...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(NAME)}))?.click()`)
for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('.cockpit-stage__body:not([hidden]) .cockpit-pane .xterm-helper-textarea')`)); i++) await sleep(250)

let out = ''
client.onNotification((m: string, p: any) => { if ((m === 'session.data' || m === 'terminal.data') && typeof p.chunk === 'string') out += p.chunk })
await client.call('session.attach', { workspaceId, idOrName: created.id })
await sleep(800)

const panes = (): Promise<number> => ev(`document.querySelectorAll('.cockpit-stage__body:not([hidden]) .cockpit-pane').length`)
const focusTerm = (): Promise<unknown> => ev(`document.querySelector('.cockpit-stage__body:not([hidden]) .cockpit-pane .xterm-helper-textarea')?.focus()`)
const plain = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const key = async (k: string, opts: { ctrl?: boolean; vk?: number; code?: string } = {}): Promise<void> => {
  const base = { key: k, code: opts.code ?? (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k), windowsVirtualKeyCode: opts.vk ?? k.toUpperCase().charCodeAt(0), modifiers: opts.ctrl ? 2 : 0 }
  await call('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(250)
}
/** One composing keystroke: the browser reports it as key "Process", virtual key 229, while a composition is open. */
const composingKey = async (): Promise<void> => {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Process', code: 'KeyS', windowsVirtualKeyCode: 229 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyS', windowsVirtualKeyCode: 229 })
  await sleep(200)
}
const compose = async (steps: string[], commit: string): Promise<void> => {
  for (const text of steps) { await call('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); await composingKey() }
  await call('Input.insertText', { text: commit })
  await sleep(300)
}
const enter = async (): Promise<void> => {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(1200)
}

await focusTerm()
const before = await panes()
check('starts with one pane', before === 1, String(before))

// 1. Text composed the way Telex builds "tiếng" reaches the shell as UTF-8.
out = ''
await call('Input.insertText', { text: 'echo ' })
await compose(['t', 'ti', 'tie', 'tiê', 'tiêng', 'tiếng'], 'tiếng')
await enter()
check('composed Vietnamese text reaches the shell intact', plain(out).includes('tiếng'), JSON.stringify(plain(out).slice(-160)))

// 2. After the prefix, a composing keystroke is not a key-table command, and nothing is split or zoomed.
await focusTerm()
await key('a', { ctrl: true })
const hintHeld = (await ev(`document.querySelector('.cockpit-keyhint') !== null`)) === true
check('the prefix shows its hint', hintHeld)
out = ''
await call('Input.imeSetComposition', { text: 'a', selectionStart: 1, selectionEnd: 1 })
await composingKey()
check('a composing key after the prefix ran no command (same pane count, not zoomed)', (await panes()) === before && (await ev(`!!document.querySelector('.cockpit-stage__body.is-zoomed')`)) === false)
await call('Input.insertText', { text: 'ắ' })
await sleep(300)
check('and the composed character still arrived as text', out.includes('ắ') || plain(out).includes('ắ'), JSON.stringify(plain(out).slice(-80)))
check('and prefix mode ended (no hint left over)', (await ev(`document.querySelector('.cockpit-keyhint') !== null`)) === false)

// 3. Composition without any prefix: several sequences, all through, none of them a shortcut.
out = ''
await compose(['d', 'dd', 'đ'], 'đ')
await compose(['o', 'oo', 'ô'], 'ô')
await compose(['u', 'uw', 'ư'], 'ư')
check('đ ô ư composed with no prefix arrive as text', ['đ', 'ô', 'ư'].every((c) => plain(out).includes(c)), JSON.stringify(plain(out).slice(-60)))
check('and no pane appeared or vanished', (await panes()) === before)

await client.call('session.input', { workspaceId, idOrName: created.id, data: '\x15' }).catch(() => undefined)
await client.call('session.kill', { workspaceId, idOrName: created.id, removeWorktree: true }).catch(() => undefined)
console.log(report.join('\n'))
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
