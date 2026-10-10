#!/usr/bin/env bun
/**
 * Diff comments on the RUNNING cockpit: open Checkpoints → "This turn", comment a line, see Escape stay inside the editor,
 * press Send into a plain shell (refused, comments kept) and then into a shell that runs an agent (pasted, no Enter, bar
 * gone). The "agent" is a script named `claude` that puts the tty in raw mode and copies what it receives to a file, so the
 * check reads the bytes that really reached the pty. Run OUTSIDE the sandbox with the app open on a scratch project
 * (scratch HOME and user-data-dir, so an installed app does not take the project):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 --user-data-dir=/tmp/cwud &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/diff-comments-check.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const SHOT = process.env['COCKPIT_SHOT'] ?? ''
const NAME = `dcmt-${String(Date.now() % 100000)}`
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
async function until(what: string, expression: string, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if ((await ev(expression)) === true) return true; await sleep(200) }
  report.push(`   (timed out waiting for ${what})`)
  return false
}

// The fake agent: raw tty, no echo, everything received goes to OUT. Not `exec`: the shell must stay `claude` for the
// status inference to see an agent.
const scratch = mkdtempSync(join(tmpdir(), 'cw-dcmt-'))
const bin = join(scratch, 'bin')
mkdirSync(bin)
const OUT = join(scratch, 'received.bin')
writeFileSync(join(bin, 'claude'), `#!/bin/sh\nstty raw -echo\nprintf '> '\ncat > '${OUT}'\n`)
chmodSync(join(bin, 'claude'), 0o755)

const client = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
const workspaceId = ((await client.call('workspace.list')) as Array<{ id: string }>)[0]!.id
await client.call('session.new', { workspaceId, name: NAME })
await sleep(3500)
await client.call('session.start', { workspaceId, idOrName: NAME })
await client.call('session.attach', { workspaceId, idOrName: NAME })
const listed = async (): Promise<{ worktreePath: string; agent?: string | null }> =>
  ((await client.call('session.list', { workspaceId })) as Array<{ name: string; worktreePath: string; agent?: string | null }>).find((s) => s.name === NAME)!
const file = join((await listed()).worktreePath, 'calc.ts')

writeFileSync(file, 'export const a = 1\nexport const b = 2\nexport const c = 3\n')
await client.call('checkpoint.take', { workspaceId, idOrName: NAME, label: 'before' })
writeFileSync(file, 'export const a = 1\nexport const REPLACED = 2\nexport const c = 3\n')
await client.call('checkpoint.take', { workspaceId, idOrName: NAME, label: 'after' })

for (let i = 0; i < 3; i++) { await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))`); await sleep(200) }
let offered = false
for (let i = 0; i < 25 && !offered; i++) {
  await ev(`(() => { const r = [...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(NAME)})); r?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 })) })()`)
  await sleep(500)
  offered = (await ev(`(() => { const b = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith('Checkpoints')); b?.click(); return !!b })()`)) === true
}
check('the row menu offers "Checkpoints…"', offered)
await sleep(1500)
await ev(`[...document.querySelectorAll('.cockpit-checkpoints__row')][0]?.querySelectorAll('button')[0]?.click()`)
const diffShown = await until('the diff', `document.querySelectorAll('.cockpit-diff-add').length > 0`)
check('"This turn" shows a diff with comment buttons in the gutter', diffShown)
check('file headers and the hunk line have no button', (await ev(`document.querySelectorAll('.cockpit-diff-gutter').length`)) >= 4)

const rowOf = `[...document.querySelectorAll('.cockpit-diff-row')].find((r) => r.querySelector('.cockpit-diff-line')?.textContent.includes('REPLACED'))`
await ev(`${rowOf}?.querySelector('.cockpit-diff-add')?.click()`)
check('the button opens an editor with focus in it', await until('the editor', `document.activeElement?.tagName === 'TEXTAREA'`))

// Escape closes the editor and nothing else: the dialog must stay.
await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))`)
await sleep(400)
check('Escape closes the editor but not the Checkpoints dialog', (await ev(`!!document.querySelector('.cockpit-checkpoints') && !document.querySelector('.cockpit-diff-editor')`)) === true)

await ev(`${rowOf}?.querySelector('.cockpit-diff-add')?.click()`)
await until('the editor again', `!!document.querySelector('.cockpit-diff-editor')`)
await ev(`(() => { const t = document.querySelector('.cockpit-diff-editor textarea'); t.value = 'Name this better.\\nIt is not a constant.'; t.closest('form').requestSubmit() })()`)
check('Add stores the comment under its line', await until('the comment', `document.querySelector('.cockpit-diff-comment__text')?.textContent.includes('Name this better.')`))
check('the bar counts it', (await ev(`document.querySelector('.cockpit-review-bar')?.textContent.includes('1 comment')`)) === true)
if (SHOT !== '') writeFileSync(SHOT, Buffer.from(String((await cdp('Page.captureScreenshot', { format: 'png' })).data), 'base64'))

const clickSend = (): Promise<unknown> => ev(`[...document.querySelectorAll('.cockpit-review-bar button')].find((b) => b.textContent.includes('Send to'))?.click()`)
const toast = (): Promise<string> => ev(`document.querySelector('.cockpit-toast')?.textContent ?? ''`)

// 1) a plain shell: refused, comments kept.
await clickSend()
await until('the refusal toast', `(document.querySelector('.cockpit-toast')?.textContent ?? '').includes('Not sent')`)
check('a plain shell is refused and says why', (await toast()).includes('Not sent'), await toast())
check('the comments are kept after a refusal', (await ev(`document.querySelector('.cockpit-review-bar')?.textContent.includes('1 comment')`)) === true)

// 2) an agent in the shell: pasted, no Enter.
await client.call('session.input', { workspaceId, idOrName: NAME, data: `export PATH='${bin}':"$PATH"\n` })
await client.call('session.input', { workspaceId, idOrName: NAME, data: 'claude\n' })
const sawAgent = await (async () => { for (let i = 0; i < 40; i++) { if ((await listed()).agent) return true; await sleep(250) } return false })()
check('the daemon sees an agent in the shell', sawAgent)
await sleep(4000) // the cockpit's own poll
await clickSend()
await until('the pasted toast', `(document.querySelector('.cockpit-toast')?.textContent ?? '').includes('Pasted')`)
check('Send reports the paste and tells the person to press Enter', (await toast()).includes('Pasted 1 comment') && (await toast()).includes('press Enter'), await toast())
check('the bar is gone once delivered', await until('the bar to go', `!document.querySelector('.cockpit-review-bar')`))
await sleep(500)
const got = readFileSync(OUT, 'latin1')
check('the bytes that reached the agent are one bracketed paste', got.startsWith('\x1b[200~') && got.endsWith('\x1b[201~'), JSON.stringify(got.slice(0, 60)))
check('…naming the file, the line, the quote and the comment', got.includes('calc.ts:2') && got.includes('> export const REPLACED = 2') && got.includes('Name this better.'))
check('…and no Enter was pressed for the person', !got.includes('\r'))

await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }))`)
await client.call('session.input', { workspaceId, idOrName: NAME, data: '\x04' }) // end the fake agent
console.log(report.join('\n'))
console.log(`${report.filter((r) => r.startsWith('BAD')).length} failing of ${report.filter((r) => /^(ok|BAD)/.test(r)).length}`)
process.exit(report.some((r) => r.startsWith('BAD')) ? 1 : 0)
