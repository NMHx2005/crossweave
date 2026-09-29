#!/usr/bin/env bun
/**
 * The prompt composer on the RUNNING cockpit: a draft is refined by the person's own command and only PROPOSED,
 * nothing reaches a session until Send, an agent gets one bracketed paste with no Enter, a plain shell is refused
 * a multi-line prompt, Enter is pressed only when ticked. A fake agent named `claude` (raw tty, `cat -v` into a log)
 * shows the exact bytes it received. Needs, BEFORE the app starts, a scratch HOME whose ~/.crossweave/settings.json has
 * prompt.refine.command pointing at the fake refine script. Run OUTSIDE the sandbox (scratch HOME wise):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 &
 *   PROMPT_BIN=/dir/with/claude-and-refine HOME=… COCKPIT_PROJECT_ROOT=… bun apps/cockpit/scripts/prompt-check.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const BIN = process.env['PROMPT_BIN'] ?? ''
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const LOG = join(BIN, 'prompt.log')
const TAG = String(Date.now() % 100000)
const AGENT = `pa-${TAG}`
const SHELL = `pb-${TAG}`
const { DaemonClient } = await import(`${REPO}/src/client/rpc-client.ts`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
if (BIN === '' || !existsSync(join(BIN, 'claude'))) { console.error('PROMPT_BIN must hold the fake claude and refine scripts'); process.exit(2) }
writeFileSync(LOG, '')

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
const log = (): string => readFileSync(LOG, 'utf8')

const client = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
const workspaceId = ((await client.call('workspace.list')) as Array<{ id: string }>)[0]!.id
for (const name of [AGENT, SHELL]) {
  await client.call('session.new', { workspaceId, name })
  await client.call('session.start', { workspaceId, idOrName: name })
  await sleep(1500)
}
await sleep(4000)
await client.call('session.input', { workspaceId, idOrName: AGENT, data: `${join(BIN, 'claude')}\r` })
await sleep(6000) // the process sweep must see the agent before the composer plans a paste

const open = async (): Promise<boolean> => { await ev(`document.querySelector('button[aria-label="Prompt"]')?.click()`); await sleep(1200); return (await ev(`!!document.querySelector('.cockpit-prompt')`)) === true }
const type = (text: string): Promise<unknown> => ev(`(() => { const a = document.querySelector('.cockpit-prompt__draft'); a.value = ${JSON.stringify(text)}; a.dispatchEvent(new Event('input', { bubbles: true })) })()`)
const click = (label: string): Promise<unknown> => ev(`[...document.querySelectorAll('.cockpit-prompt button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`)
const tick = (name: string): Promise<unknown> => ev(`[...document.querySelectorAll('.cockpit-prompt__targets label')].find((l) => l.textContent.includes(${JSON.stringify(name)}))?.querySelector('input')?.click()`)
const plan = (): Promise<string> => ev(`document.querySelector('.cockpit-prompt__plan')?.innerText ?? ''`)

check('the Prompt button opens the composer', await open())
check('Refine is offered because a command is set', (await ev(`[...document.querySelectorAll('.cockpit-prompt button')].some((b) => b.textContent.trim() === 'Refine')`)) === true)

await type('fix the login bug\nkeep the tests green')
await click('Refine')
await sleep(2500)
const proposal = String(await ev(`document.querySelector('.cockpit-prompt__proposal pre')?.innerText ?? ''`))
check('Refine shows a proposal from the person\'s own command', proposal.includes('REFINED:'), proposal.replace(/\n/g, ' / ').slice(0, 80))
check('refining sent nothing anywhere', log() === '', JSON.stringify(log()))
const draftBefore = String(await ev(`document.querySelector('.cockpit-prompt__draft').value`))
check('the draft is untouched until the proposal is accepted', draftBefore.startsWith('fix the login bug'))
await click('Use this')
await sleep(300)
check('"Use this" puts the proposal in the draft', String(await ev(`document.querySelector('.cockpit-prompt__draft').value`)).includes('REFINED:'))

await tick(AGENT)
await tick(SHELL)
await sleep(400)
const p = await plan()
check('the preview says one paste for the agent', p.includes(AGENT) && /one paste into its agent/.test(p), p.replace(/\n/g, ' | '))
check('and refuses the plain shell for a multi-line prompt, saying why', p.includes(SHELL) && /not sent: a plain shell would run each line/.test(p))
check('nothing was sent yet', log() === '')

await click('Send')
await sleep(2500)
const got = log()
check('the agent received ONE bracketed paste of the refined prompt', got.startsWith('^[[200~') && got.includes('REFINED:') && got.trimEnd().endsWith('^[[201~'), JSON.stringify(got.slice(0, 90)))
check('with no Enter after it', !got.includes('^M'), JSON.stringify(got.slice(-20)))
check('the composer closed and said what happened', (await ev(`!!document.querySelector('.cockpit-prompt')`)) === false && String(await ev(`document.querySelector('.cockpit-toast')?.innerText ?? ''`)).includes(`Sent to ${AGENT}`))

await open()
check('the draft is gone after a send', String(await ev(`document.querySelector('.cockpit-prompt__draft').value`)) === '')
await type('one more line')
await tick(AGENT)
await ev(`[...document.querySelectorAll('.cockpit-prompt .cockpit-settings__toggle input')][0]?.click()`)
await sleep(300)
await click('Send')
await sleep(2500)
check('Enter is pressed only when ticked', log().endsWith('^[[201~^M') || log().includes('^[[201~^M'), JSON.stringify(log().slice(-30)))

await open()
await ev(`document.querySelector('.cockpit-prompt')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(300)
check('Escape closes it', (await ev(`!!document.querySelector('.cockpit-prompt')`)) === false)

for (const name of [AGENT, SHELL]) {
  await client.call('session.input', { workspaceId, idOrName: name, data: '\x03' }).catch(() => undefined)
  await client.call('session.kill', { workspaceId, idOrName: name, removeWorktree: true }).catch(() => undefined)
}
console.log(report.join('\n'))
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
