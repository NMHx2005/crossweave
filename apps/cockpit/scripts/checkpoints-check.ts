#!/usr/bin/env bun
/**
 * "Checkpoints…" on the RUNNING cockpit: the row menu offers it, the dialog lists a session's checkpoints, "Checkpoint
 * now" takes one, "This turn" shows what changed between two, "Restore…" asks first with the plan in plain words and
 * then puts the file back on disk. Run OUTSIDE the sandbox with the app open on a scratch project (scratch HOME and
 * user-data-dir, so an installed app does not take the project):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 --user-data-dir=/tmp/cwud &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/checkpoints-check.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const SHOT = process.env['COCKPIT_SHOT'] ?? ''
const NAME = `ckpt-${String(Date.now() % 100000)}`
const { DaemonClient } = await import(`${REPO}/src/client/rpc-client.ts`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const cdp = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve) => {
  const id = ++seq
  const on = (e: MessageEvent): void => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown }
    if (m.id !== id) return
    ws.removeEventListener('message', on)
    resolve(m.result)
  }
  ws.addEventListener('message', on)
  ws.send(JSON.stringify({ id, method, params }))
})
const ev = async (expression: string): Promise<any> => (await cdp('Runtime.evaluate', { expression, returnByValue: true })).result?.value
const report: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => { report.push(`${ok ? 'ok ' : 'BAD'} ${name}${extra ? ' — ' + extra : ''}`) }

const client = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
const workspaceId = ((await client.call('workspace.list')) as Array<{ id: string }>)[0]!.id
await client.call('session.new', { workspaceId, name: NAME })
await sleep(3500)
const worktree = ((await client.call('session.list', { workspaceId })) as Array<{ name: string; worktreePath: string }>).find((s) => s.name === NAME)!.worktreePath
const file = join(worktree, 'notes.txt')

// State one: a file with a line. Taken through the RPC so the dialog has something to list when it opens.
writeFileSync(file, 'first line\n')
await client.call('checkpoint.take', { workspaceId, idOrName: NAME, label: 'before the agent' })
// The "agent" edits it.
writeFileSync(file, 'first line\nthe agent added this line\n')

// A menu or dialog left open by an earlier run would answer for the wrong session: start from a clean window.
for (let i = 0; i < 3; i++) { await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))`); await sleep(200) }
// The rail refreshes on its own schedule and can close a menu opened a moment too early: ask until the item is there.
let offered = false
for (let i = 0; i < 25 && !offered; i++) {
  await ev(`(() => { const r = [...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(NAME)})); r?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 })) })()`)
  await sleep(500)
  offered = (await ev(`(() => { const b = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith('Checkpoints')); b?.click(); return !!b })()`)) === true
}
check('the row menu offers "Checkpoints…"', offered)
await sleep(1500)
check('the dialog opens and lists the first checkpoint', (await ev(`!!document.querySelector('.cockpit-checkpoints') && document.querySelector('.cockpit-checkpoints').innerText.includes('before the agent')`)) === true)

await ev(`[...document.querySelectorAll('.cockpit-checkpoints button')].find((b) => b.textContent.trim() === 'Checkpoint now')?.click()`)
await sleep(2000)
const rows = await ev(`document.querySelectorAll('.cockpit-checkpoints__row').length`)
check('"Checkpoint now" adds a second row', rows === 2, String(rows))
const rowText = String(await ev(`document.querySelector('.cockpit-checkpoints__row')?.innerText ?? ''`))
check('the newest row counts the change (+0 ~1 −0)', /#2/.test(rowText) && /\+0 ~1 −0/.test(rowText), rowText.replace(/\s+/g, ' '))

await ev(`[...document.querySelectorAll('.cockpit-checkpoints__row')][0]?.querySelectorAll('button')[0]?.click()`)
await sleep(1500)
const patch = String(await ev(`document.querySelector('.cockpit-checkpoints .cockpit-changes__patch')?.innerText ?? ''`))
check('"This turn" shows the line the agent added', /the agent added this line/.test(patch), patch.replace(/\s+/g, ' ').slice(0, 100))
if (SHOT !== '') {
  const png = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(SHOT, Buffer.from(String(png.data), 'base64'))
}

// Restore the OLDER checkpoint (second row): the confirmation names the plan, then the file is back on disk.
await ev(`[...document.querySelectorAll('.cockpit-checkpoints__row')][1]?.querySelectorAll('button')[2]?.click()`)
await sleep(1200)
const confirm = String(await ev(`document.querySelector('.cockpit-confirm')?.innerText ?? ''`))
check('Restore… asks first, with the plan in words', /Restore checkpoint #1\?/.test(confirm) && /Write 1 file, delete 0 files\./.test(confirm) && /notes\.txt/.test(confirm) && /return point is saved first/.test(confirm), confirm.replace(/\s+/g, ' '))
check('nothing was written before the answer', readFileSync(file, 'utf8').includes('the agent added this line'))
await ev(`[...document.querySelectorAll('.cockpit-confirm button')].find((b) => b.textContent.trim() === 'Restore')?.click()`)
await sleep(2000)
check('confirming puts the file back on disk', readFileSync(file, 'utf8') === 'first line\n', JSON.stringify(readFileSync(file, 'utf8')))

await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }))`)
console.log(report.join('\n'))
console.log(`${report.filter((r) => r.startsWith('BAD')).length} failing of ${report.length}`)
process.exit(report.some((r) => r.startsWith('BAD')) ? 1 : 0)
