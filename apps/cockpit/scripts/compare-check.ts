#!/usr/bin/env bun
/**
 * "Compare with another…" on the RUNNING cockpit: two sessions that each committed a change, one file in common,
 * are shown side by side with the shared file marked, a file's patch opens, each side has its own land button, and
 * Escape closes it. Run OUTSIDE the sandbox with the app open on a scratch project (scratch HOME wise):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/compare-check.ts
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const TAG = String(Date.now() % 100000)
const A = `cmpa-${TAG}`
const B = `cmpb-${TAG}`
const { DaemonClient } = await import(`${REPO}/src/client/rpc-client.ts`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const ev = (expression: string): Promise<any> => new Promise((resolve) => {
  const id = ++seq
  const on = (e: MessageEvent): void => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: { result?: { value?: unknown } } }
    if (m.id !== id) return
    ws.removeEventListener('message', on)
    resolve(m.result?.result?.value)
  }
  ws.addEventListener('message', on)
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
})
const report: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => { report.push(`${ok ? 'ok ' : 'BAD'} ${name}${extra ? ' — ' + extra : ''}`) }

const client = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
const workspaceId = ((await client.call('workspace.list')) as Array<{ id: string }>)[0]!.id
// One at a time, with a pause: two creations in the same instant can land in one refresh of the rail.
for (const name of [A, B]) { await client.call('session.new', { workspaceId, name }); await sleep(2000) }
const listed = (await client.call('session.list', { workspaceId })) as Array<{ name: string; worktreePath: string }>
const commit = (name: string, files: Record<string, string>): void => {
  const dir = listed.find((s) => s.name === name)!.worktreePath
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body)
  Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
  Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', name], { cwd: dir })
}
commit(A, { 'shared.txt': 'from a\n', 'only-a.txt': 'a\n' })
commit(B, { 'shared.txt': 'from b\n', 'only-b.txt': 'b\n' })
await sleep(3500)

const q = (sel: string, code: string): Promise<any> => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? (${code}) : null })()`)
await ev(`(() => { const r = [...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(A)})); r?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 })) })()`)
await sleep(400)
const clicked = await ev(`(() => { const b = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith('Compare with another')); b?.click(); return !!b })()`)
check('the row menu offers "Compare with another…"', clicked === true)
await sleep(2500)

check('the comparison opens', (await q('.cockpit-compare', 'true')) === true)
// The default opposite is the session overlapping most (unknown until the first scan) or the first other one; choose B.
await ev(`(() => { const sel = document.querySelectorAll('.cockpit-compare select')[1]; sel.value = [...sel.options].find((o) => o.text === ${JSON.stringify(B)}).value; sel.dispatchEvent(new Event('change', { bubbles: true })) })()`)
await sleep(2500)
const selects = await ev(`[...document.querySelectorAll('.cockpit-compare select')].map((s) => s.options[s.selectedIndex].text)`)
check('this session is on the left, another opposite it', Array.isArray(selects) && selects[0] === A && selects[1] === B, JSON.stringify(selects) + ' options=' + JSON.stringify(await ev(`[...document.querySelectorAll('.cockpit-compare select')[0].options].map((o) => o.text + (o.disabled ? '(x)' : ''))`)))
const text = String(await q('.cockpit-compare', 'el.innerText'))
check('it says how many files both touched', /1 file touched by both/.test(text), text.split('\n').slice(0, 3).join(' / '))
const bothCount = await ev(`document.querySelectorAll('.cockpit-compare .cockpit-compare__both').length`)
check('the shared file is marked on both sides', bothCount === 2, String(bothCount))
check('each side lists its own file', /only-a\.txt/.test(text) && /only-b\.txt/.test(text))
const lands = await ev(`[...document.querySelectorAll('.cockpit-compare button')].filter((b) => b.textContent.trim() === 'Land this one').length`)
check('each side has its own land button', lands === 2, String(lands))

await ev(`document.querySelector('.cockpit-compare .cockpit-changes__files button')?.click()`)
await sleep(300)
const patch = String(await q('.cockpit-compare__patch', 'el.innerText'))
check('opening a file shows its patch', /from a/.test(patch), patch.slice(0, 60))

await ev(`document.querySelector('.cockpit-compare')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(300)
check('Escape closes it', (await q('.cockpit-compare', 'true')) === null)

for (const name of [A, B]) await client.call('session.kill', { workspaceId, idOrName: name, removeWorktree: true }).catch(() => undefined)
console.log(report.join('\n'))
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
