#!/usr/bin/env bun
/**
 * Auto-check on the RUNNING cockpit, with `checks.autoRun` on in the scratch HOME's settings: an "agent" edits a file and ends
 * its turn → the rail's chip turns `✗ tests` by itself (nobody pressed Run checks) → the row menu offers "Send test failure to
 * shell" → the bytes that reach the agent are one bracketed paste with the failure text and no Enter. The agent is a script
 * named `claude` that, after its turn, puts the tty in raw mode and copies what it receives to a file. Run OUTSIDE the sandbox
 * against a scratch repo (a scratch HOME and user-data-dir, so an installed app does not take the project) whose
 * crossweave.config.json has converge.testCommand `test ! -f agent-made.txt`, with the daemon built from this branch:
 *
 *   mkdir -p /tmp/cwac/home/.crossweave && echo '{"checks":{"autoRun":true}}' > /tmp/cwac/home/.crossweave/settings.json
 *   HOME=/tmp/cwac/home COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 --user-data-dir=/tmp/cwac/ud &
 *   HOME=/tmp/cwac/home COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/auto-check-check.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const SHOT = process.env['COCKPIT_SHOT'] ?? ''
const NAME = `autochk-${String(Date.now() % 100000)}`
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
async function until(what: string, expression: string, ms = 30000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if ((await ev(expression)) === true) return true; await sleep(300) }
  report.push(`   (timed out waiting for ${what})`)
  return false
}

const scratch = mkdtempSync(join(tmpdir(), 'cw-autochk-'))
const bin = join(scratch, 'bin')
mkdirSync(bin)
const OUT = join(scratch, 'received.bin')
writeFileSync(join(bin, 'claude'), [
  '#!/bin/sh',
  'i=0',
  `while [ $i -lt 8 ]; do printf '\\033[2K\\033[1m✢ Crunching…\\033[0m (1s · esc to interrupt)\\n'; if [ $i -eq 6 ]; then echo made > agent-made.txt; fi; sleep 0.5; i=$((i+1)); done`,
  `printf '\\033[2J\\033[H> '`,
  'stty raw -echo',
  `cat > '${OUT}'`,
  '',
].join('\n'))
chmodSync(join(bin, 'claude'), 0o755)

const client = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
const workspaceId = ((await client.call('workspace.list')) as Array<{ id: string }>)[0]!.id
await client.call('config.trust', { workspaceId })
await client.call('session.new', { workspaceId, name: NAME })
await sleep(3500)
await client.call('session.start', { workspaceId, idOrName: NAME })
await client.call('session.attach', { workspaceId, idOrName: NAME })

for (let i = 0; i < 3; i++) { await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))`); await sleep(200) }
const rowText = (): Promise<string> => ev(`[...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(NAME)}))?.textContent ?? ''`)
await until('the session row', `[...document.querySelectorAll('.cockpit-row')].some((x) => x.textContent.includes(${JSON.stringify(NAME)}))`)
check('no verdict before the agent has done anything', !(await rowText()).includes('tests'))

// The agent works, edits a file, ends its turn. Nobody presses Run checks.
await client.call('session.input', { workspaceId, idOrName: NAME, data: `export PATH='${bin}':"$PATH"\n` })
await client.call('session.input', { workspaceId, idOrName: NAME, data: 'claude\n' })
const failed = await until('the chip to read ✗ tests', `[...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(NAME)}))?.textContent.includes('✗ tests') === true`, 45000)
check('the rail shows "✗ tests" by itself when the agent ends a turn that changed a file', failed, await rowText())
if (SHOT !== '') writeFileSync(SHOT, Buffer.from(String((await cdp('Page.captureScreenshot', { format: 'png' })).data), 'base64'))

// The row menu offers the failure only now that there is one.
const toast = (): Promise<string> => ev(`document.querySelector('.cockpit-toast')?.textContent ?? ''`)
let offered = false
for (let i = 0; i < 25 && !offered; i++) {
  await ev(`(() => { const r = [...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(NAME)})); r?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 })) })()`)
  await sleep(500)
  offered = (await ev(`(() => { const b = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === 'Send test failure to shell'); b?.click(); return !!b })()`)) === true
}
check('the row menu offers "Send test failure to shell"', offered)
await until('the pasted toast', `(document.querySelector('.cockpit-toast')?.textContent ?? '').includes('Pasted')`)
check('it reports the paste and tells the person to press Enter', (await toast()).includes('Pasted the test failure') && (await toast()).includes('press Enter'), await toast())
await sleep(800)
const got = readFileSync(OUT, 'latin1')
check('the agent received one bracketed paste', got.startsWith('\x1b[200~') && got.endsWith('\x1b[201~'), JSON.stringify(got.slice(0, 70)))
check("…that says the project's tests failed, with the end of the output", got.includes("The project's tests failed") && got.includes('End of the output'))
check('…and no Enter was pressed for the person', !got.includes('\r'))

await client.call('session.input', { workspaceId, idOrName: NAME, data: '\x04' }).catch(() => undefined)
console.log(report.join('\n'))
console.log(`${report.filter((r) => r.startsWith('BAD')).length} failing of ${report.filter((r) => /^(ok|BAD)/.test(r)).length}`)
process.exit(report.some((r) => r.startsWith('BAD')) ? 1 : 0)
