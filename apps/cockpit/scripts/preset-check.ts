#!/usr/bin/env bun
/**
 * A session preset on the RUNNING cockpit: the new-session picker lists it with what one click will do, and the click
 * starts the session, runs the preset's command in an extra terminal beside it (proved by a file the command writes in the
 * session's worktree) and opens a Browser pane on the session's leased port. Needs, BEFORE the app starts, a scratch HOME whose
 * ~/.crossweave/settings.json has one preset named "web dev" with terminals ["echo PRESET_TERM_OK > preset-term.txt"] and
 * browser {path: "/x"}. Run OUTSIDE the sandbox (scratch HOME wise):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/preset-check.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
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
const before = new Set(((await client.call('session.list', { workspaceId })) as Array<{ id: string }>).map((s) => s.id))
for (let i = 0; i < 40 && !(await ev(`document.querySelector('.cockpit-pane') !== null || document.querySelector('button[aria-label="New session"]') !== null`)); i++) await sleep(250)

await ev(`document.querySelector('button[aria-label="New session"]')?.click()`)
await sleep(1500)
const group = String(await ev(`document.querySelector('.cockpit-picker__presets')?.innerText ?? ''`))
check('the picker lists the preset', /web dev/.test(group), group.replace(/\n/g, ' | '))
check('and says what one click will do', /own worktree/.test(group) && /runs echo PRESET_TERM_OK/.test(group) && /browser on its port/.test(group))

await ev(`[...document.querySelectorAll('.cockpit-picker__preset')].find((b) => b.textContent.includes('web dev'))?.click()`)
let toast = ''
for (let i = 0; i < 24 && !toast.includes('Started web dev'); i++) { await sleep(500); toast = String(await ev(`[...document.querySelectorAll('.cockpit-toast')].map((t) => t.innerText).join(' | ')`)) }
await sleep(1500)

const after = (await client.call('session.list', { workspaceId })) as Array<{ id: string; name: string; worktreePath: string; status: string; leases?: { portBase: number | null } }>
const created = after.find((s) => !before.has(s.id))
check('a session was created and started', created !== undefined && created.name.startsWith('web-dev') && (created.status === 'running' || created.status === 'waiting'), created ? `${created.name} ${created.status}` : 'none')
const marker = created ? join(created.worktreePath, 'preset-term.txt') : ''
check('the preset\'s command ran in an extra terminal, in the session\'s worktree', marker !== '' && existsSync(marker) && readFileSync(marker, 'utf8').includes('PRESET_TERM_OK'), marker)
const url = String(await ev(`document.querySelector('.cockpit-browser input')?.value ?? ''`))
check('a Browser pane opened on the session\'s leased port, at the preset\'s path', created?.leases?.portBase != null && url === `http://localhost:${created.leases.portBase}/x`, url)
check('the window said it started the preset', toast.includes('Started web dev'), toast)

if (created) await client.call('session.kill', { workspaceId, idOrName: created.id, removeWorktree: true }).catch(() => undefined)
console.log(report.join('\n'))
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
