#!/usr/bin/env bun
/**
 * `cw notify` against the RUNNING cockpit: a session that says it is done gets the ✓ and its words in the row's
 * tooltip, opening it clears the ✓, `--kind ask` turns the row amber until the next keystroke, and bad input is refused.
 * Run OUTSIDE the sandbox with the app open on a scratch project (scratch HOME wise):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/notify-check.ts
 */
const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const NAME = `notify-${Date.now() % 100000}`
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
const created = (await client.call('session.new', { workspaceId, name: NAME })) as { id: string }
await client.call('session.start', { workspaceId, idOrName: created.id })
// A plain shell counts as working while it is printing (its prompt, an echo): wait it out.
await sleep(6500)

const row = (): Promise<string> => ev(`(() => { const r = [...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(NAME)})); if (!r) return 'no-row'; const st = r.querySelector('.cockpit-status'); const glyph = st ? (getComputedStyle(st).visibility === 'hidden' ? 'blank' : st.className.replace('cockpit-status cockpit-status--', '')) : 'none'; return glyph + (r.querySelector('.cockpit-row__done') ? ' +tick' : '') + ' | ' + (r.title || '') })()`)
const cw = (...args: string[]): Promise<{ out: string; err: string; code: number }> => {
  const proc = Bun.spawn([process.execPath, `${REPO}/src/cli/index.ts`, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CW_SESSION_ID: created.id } })
  return (async () => ({ out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text(), code: await proc.exited }))()
}

check('a fresh shell shows no mark', (await row()).startsWith('blank'), await row())

const done = await cw('notify', 'tests', 'written')
await sleep(2500)
const afterDone = await row()
check('cw notify marks the row finished with the ✓', done.code === 0 && afterDone.startsWith('blank +tick'), afterDone)
check('its words are in the row tooltip', afterDone.includes('tests written'))

await ev(`[...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(NAME)}))?.click()`)
await sleep(1500)
check('opening the session clears the ✓', !(await row()).includes('+tick'), await row())

const ask = await cw('notify', '--kind', 'ask', 'which branch?')
await sleep(2500)
const afterAsk = await row()
check('--kind ask turns the row amber', ask.code === 0 && afterAsk.startsWith('asked'), afterAsk)

await client.call('session.input', { workspaceId, idOrName: created.id, data: 'a' })
await sleep(6000)
check('the next keystroke clears it', (await row()).startsWith('blank'), await row())

const badKind = await cw('notify', '--kind', 'run', 'x')
check('a bad kind is refused', badKind.code === 1 && /INVALID_ARGUMENTS/.test(badKind.err), badKind.err.trim())
const tooLong = await cw('notify', 'x'.repeat(300))
check('an over-long message is refused, not cut', tooLong.code === 1 && /INVALID_PARAMS/.test(tooLong.err), tooLong.err.trim())

await client.call('session.kill', { workspaceId, idOrName: created.id, removeWorktree: true }).catch(() => undefined)
console.log(report.join('\n'))
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
