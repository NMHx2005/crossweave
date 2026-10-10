#!/usr/bin/env bun
/**
 * Sensitive-file flags on the RUNNING cockpit: a session whose branch commits a production env file, a package.json change and a CI
 * workflow shows a labelled badge on each in the Changes pane, one summary line, and pressing Land asks first — naming the env file and the
 * workflow (the kinds that make Land ask) but not the dependency (badge only). Cancel leaves the session unlanded. Run OUTSIDE the
 * sandbox (it denies reading files like these, and the fixture needs `git add`) with the app open on a scratch project:
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --remote-debugging-port=9333 --user-data-dir=/tmp/cwud &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/sensitive-files-check.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const SHOT = process.env['COCKPIT_SHOT'] ?? ''
const NAME = `sens-${String(Date.now() % 100000)}`
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
async function until(what: string, expression: string, ms = 20000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if ((await ev(expression)) === true) return true; await sleep(300) }
  report.push(`   (timed out waiting for ${what})`)
  return false
}

const client = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
const workspaceId = ((await client.call('workspace.list')) as Array<{ id: string }>)[0]!.id
await client.call('session.new', { workspaceId, name: NAME })
await sleep(3500)
const listed = async (): Promise<{ worktreePath: string; status?: string } | undefined> =>
  ((await client.call('session.list', { workspaceId })) as Array<{ name: string; worktreePath: string; status?: string }>).find((s) => s.name === NAME)

// The branch commits three kinds of file: one that asks at Land, one that asks (automation) and one that only gets a badge.
const worktree = (await listed())!.worktreePath
mkdirSync(join(worktree, '.github', 'workflows'), { recursive: true })
writeFileSync(join(worktree, '.env.production'), 'API_BASE=https://example.invalid\n')
writeFileSync(join(worktree, 'package.json'), '{ "name": "scratch", "version": "1.0.0" }\n')
writeFileSync(join(worktree, '.github', 'workflows', 'ci.yml'), 'name: ci\non: push\n')
writeFileSync(join(worktree, 'src.ts'), 'export const ordinary = 1\n')
const git = (...args: string[]): void => {
  const r = Bun.spawnSync(['git', '-C', worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
}
git('add', '-A')
git('commit', '-q', '-m', 'sensitive fixture')

for (let i = 0; i < 3; i++) { await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))`); await sleep(200) }
let offered = false
for (let i = 0; i < 25 && !offered; i++) {
  await ev(`(() => { const r = [...document.querySelectorAll('.cockpit-row')].find((x) => x.textContent.includes(${JSON.stringify(NAME)})); r?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 })) })()`)
  await sleep(500)
  offered = (await ev(`(() => { const b = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === 'Changes'); b?.click(); return !!b })()`)) === true
}
check('the row menu offers Changes', offered)
check('the Changes pane lists the files', await until('the file list', `document.querySelectorAll('.cockpit-changes__files li').length >= 4`))

const rowOf = (path: string): string => `[...document.querySelectorAll('.cockpit-changes__files li')].find((li) => li.querySelector('.cockpit-changes__path')?.textContent === ${JSON.stringify(path)})`
const badgeOf = async (path: string): Promise<string> => String(await ev(`${rowOf(path)}?.querySelector('.cockpit-sensitive')?.firstChild?.textContent ?? ''`))
check('the env file is badged "secret"', (await badgeOf('.env.production')) === 'secret')
check('the workflow is badged "automation"', (await badgeOf('.github/workflows/ci.yml')) === 'automation')
check('package.json is badged "dependency"', (await badgeOf('package.json')) === 'dependency')
check('an ordinary file carries no badge', (await badgeOf('src.ts')) === '' && (await ev(`!!${rowOf('src.ts')}`)) === true)
const summary = String(await ev(`[...document.querySelectorAll('.cockpit-changes__note')].map((n) => n.textContent).find((t) => t.includes('sensitive')) ?? ''`))
check('one summary line counts them, the kinds that ask first', summary.includes('3 sensitive files: 1 secret · 1 automation · 1 dependency'), summary)
check('the reason is in the text a screen reader gets', (await ev(`${rowOf('.env.production')}?.querySelector('.cockpit-sr-only')?.textContent.includes('secret or credential')`)) === true)
if (SHOT !== '') writeFileSync(SHOT, Buffer.from(String((await cdp('Page.captureScreenshot', { format: 'png' })).data), 'base64'))

// Land asks first; the dependency is not part of the question.
check('Land becomes available', await until('the Land button', `!!document.querySelector('.cockpit-changes__land') && !document.querySelector('.cockpit-changes__land').disabled`))
await ev(`document.querySelector('.cockpit-changes__land')?.click()`)
check('Land opens a confirmation', await until('the confirmation', `!!document.querySelector('.cockpit-confirm')`))
const title = String(await ev(`document.querySelector('.cockpit-confirm .cockpit-picker__title')?.textContent ?? ''`))
const body = String(await ev(`document.querySelector('.cockpit-confirm__body')?.textContent ?? ''`))
check('it is about sensitive files, naming the session', title === `Land ${NAME} with sensitive files?`, title)
check('it names the env file and the workflow', body.includes('.env.production — secret') && body.includes('.github/workflows/ci.yml — automation'), body.replace(/\s+/g, ' ').slice(0, 160))
check('it leaves the dependency out', !body.includes('package.json'))
await ev(`[...document.querySelectorAll('.cockpit-confirm button')].find((b) => b.textContent.trim() === 'Cancel')?.click()`)
await sleep(1200)
check('Cancel closes it', (await ev(`!document.querySelector('.cockpit-confirm')`)) === true)
const after = await listed()
check('the session is still there and was not landed', after !== undefined && after.status !== 'landed', String(after?.status))

await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }))`)
console.log(report.join('\n'))
console.log(`${report.filter((r) => r.startsWith('BAD')).length} failing of ${report.filter((r) => /^(ok|BAD)/.test(r)).length}`)
process.exit(report.some((r) => r.startsWith('BAD')) ? 1 : 0)
