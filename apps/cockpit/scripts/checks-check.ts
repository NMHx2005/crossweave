#!/usr/bin/env bun
/**
 * `cw check` and the rail's tests chip against the RUNNING cockpit: an untrusted command is never run, a failing
 * run shows ✗ with the output, a passing one shows ✓, and the ✓ goes dim once the work moves on. The project needs
 * `converge.testCommand` = `test -f ok.txt || (echo missing ok.txt; exit 1)` in crossweave.config.json BEFORE its daemon
 * starts. Run OUTSIDE the sandbox with the app open on a scratch project (scratch HOME wise):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/checks-check.ts
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const NAME = `checks-${Date.now() % 100000}`
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
const created = (await client.call('session.new', { workspaceId, name: NAME })) as { id: string; worktreePath: string }
const worktree = ((await client.call('session.list', { workspaceId })) as Array<{ id: string; worktreePath: string }>).find((s) => s.id === created.id)!.worktreePath
await sleep(2500)

const chip = (): Promise<string> => ev(`(() => { const r = [...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(NAME)})); const c = r?.querySelector('.cockpit-testchip'); return c ? c.textContent + (c.classList.contains('is-stale') ? ' (stale)' : '') + ' | ' + c.title : 'none' })()`)
const cw = (...args: string[]): Promise<{ out: string; err: string; code: number }> => {
  const proc = Bun.spawn([process.execPath, `${REPO}/src/cli/index.ts`, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env })
  return (async () => ({ out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text(), code: await proc.exited }))()
}

check('no chip before any check', (await chip()) === 'none')

await cw('config', 'untrust')
const untrusted = await cw('check', NAME)
check('an untrusted command is refused, never run', untrusted.code === 1 && /CHECK_UNTRUSTED/.test(untrusted.err), untrusted.err.trim())

const trust = await cw('config', 'trust')
check('the person trusts it (scratch HOME)', trust.code === 0, trust.out.trim())

const failing = await cw('check', NAME)
check('a failing run exits 1 and prints its output', failing.code === 1 && /checks FAIL/.test(failing.out) && /missing ok\.txt/.test(failing.out), failing.out.trim().split('\n').join(' / '))
await sleep(1500)
const failChip = await chip()
check('the row shows ✗ tests', failChip.startsWith('✗ tests'), failChip)

writeFileSync(join(worktree, 'ok.txt'), 'x')
const passing = await cw('check', NAME)
check('once fixed, it passes and exits 0', passing.code === 0 && /checks pass/.test(passing.out), passing.out.trim())
await sleep(1500)
const passChip = await chip()
check('the row shows ✓ tests, fresh', passChip.startsWith('✓ tests') && !passChip.includes('(stale)'), passChip)

// The work moves on, the way it really does: something runs in the session's own shell (an agent editing). The
// rail only re-reads a session when something happens, so a file changed behind the daemon's back is not seen.
await client.call('session.start', { workspaceId, idOrName: created.id }).catch(() => undefined)
await sleep(3500)
await client.call('session.input', { workspaceId, idOrName: created.id, data: 'echo y > more.txt\r' })
let stale = ''
for (let i = 0; i < 12; i++) { await sleep(1500); stale = await chip(); if (stale.includes('(stale)')) break }
check('after the work moved on the ✓ goes dim, not current', stale.startsWith('✓ tests') && stale.includes('(stale)'), stale)

await client.call('session.kill', { workspaceId, idOrName: created.id, removeWorktree: true }).catch(() => undefined)
console.log(report.join('\n'))
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
