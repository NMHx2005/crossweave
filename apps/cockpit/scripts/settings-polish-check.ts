#!/usr/bin/env bun
/**
 * The settings polish and the failed-check alert, on the RUNNING cockpit over CDP: no news banner, every section with a lead, a titled first
 * card and a folded Details, a column that stays where it is, the new "When tests fail" switch, and exactly one desktop alert (no test output in
 * it) when a check fails while the window is away.
 *
 * It changes trust, creates a session and flips a notification preference, so it REFUSES to run on anything but a scratch project and a
 * scratch HOME. Prepare one BEFORE the app starts (the daemon reads the config when it starts):
 *
 *   bun apps/cockpit/scripts/settings-polish-check.ts seed ~/cw-scratch/acme-api
 *   HOME=~/cw-scratch/home COCKPIT_PROJECT_ROOT=~/cw-scratch/acme-api "…/Electron" . --remote-debugging-port=9333 --user-data-dir=~/cw-scratch/ud &
 *   HOME=~/cw-scratch/home COCKPIT_PROJECT_ROOT=~/cw-scratch/acme-api bun apps/cockpit/scripts/settings-polish-check.ts [screenshot-dir]
 *
 * Run OUTSIDE a restricted sandbox (pty + unix socket), like the other *-check.ts scripts.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const SENTINEL = 'test -f ok.txt || (echo missing ok.txt; exit 1)'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

if (process.argv[2] === 'seed') {
  const dir = process.argv[3]
  if (!dir) throw new Error('usage: settings-polish-check.ts seed <dir>')
  execFileSync('bun', [`${REPO}/apps/cockpit/scripts/demo-shot.ts`, 'seed', dir], { stdio: 'inherit' })
  writeFileSync(join(dir, 'crossweave.config.json'), `${JSON.stringify({ converge: { testCommand: SENTINEL } }, null, 2)}\n`)
  execFileSync('git', ['-C', dir, 'add', 'crossweave.config.json'])
  try { execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'chore: a test command that fails until ok.txt exists']) } catch { /* already committed */ }
  console.log(`seeded ${dir} with converge.testCommand = ${SENTINEL}`)
  process.exit(0)
}

const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? ''
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9333'
const SHOTS = process.argv[2]
const refuse = (why: string): never => { console.error(`REFUSED: ${why}`); process.exit(2) }
// `os.homedir()` follows $HOME, so the real home is recognised by its name: a person's own directory is called after them.
if (process.env['HOME'] === undefined || basename(process.env['HOME']) === userInfo().username) refuse('HOME looks like the real home directory; use a scratch HOME')
if (ROOT === '' || !existsSync(join(ROOT, 'crossweave.config.json'))) refuse('COCKPIT_PROJECT_ROOT is not a seeded scratch project')
if ((JSON.parse(readFileSync(join(ROOT, 'crossweave.config.json'), 'utf8')) as { converge?: { testCommand?: string } }).converge?.testCommand !== SENTINEL) refuse('the project is not the one `seed` makes')

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve) => {
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
const ev = async (expression: string): Promise<any> => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
const shot = async (name: string): Promise<void> => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data as string, 'base64'))
}
const report: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => { report.push(`${ok ? 'ok ' : 'BAD'} ${name}${extra ? ' — ' + extra : ''}`) }
const waitFor = async (expr: string, ms = 8000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await ev(expr)) return true
  return false
}

// Reinstalled on every load: the alert stub, and a focus switch the script owns.
const STUB = `window.__alerts = []; window.__away = true;
  window.Notification = class { constructor(title, options) { window.__alerts.push([title, options && options.body, options && options.tag]) } };
  Object.defineProperty(window.Notification, 'permission', { value: 'granted' });
  document.hasFocus = () => !window.__away;`
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })
await ev(STUB)

const cw = (...args: string[]): { out: string; err: string; code: number } => {
  const r = Bun.spawnSync([process.execPath, `${REPO}/src/cli/index.ts`, ...args], { cwd: ROOT, env: process.env })
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? 1 }
}
const { DaemonClient } = await import(`${REPO}/src/client/rpc-client.ts`)
const NAME = `polish-${Date.now() % 100000}`
let client: any
let workspaceId = ''
let switchedOff = false

const openSettings = async (): Promise<void> => {
  await ev(`document.querySelector('button[aria-label="Settings"]').click()`)
  await waitFor(`document.querySelector('.cockpit-settings-page') !== null`)
}
const nav = async (title: string): Promise<void> => {
  await ev(`[...document.querySelectorAll('.cockpit-settings-nav__item')].find((b) => b.textContent.trim() === ${JSON.stringify(title)}).click()`)
  await waitFor(`document.querySelector('.cockpit-settings-content h2')?.textContent === ${JSON.stringify(title)}`)
  await sleep(200)
}
const switchState = (label: string): Promise<string | null> => ev(`document.querySelector('.cockpit-settings-content [role=switch][aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-checked') ?? null`)
const alerts = (): Promise<Array<[string, string, string]>> => ev('window.__alerts')

try {
  for (let i = 0; i < 40 && !(await ev(`document.querySelector('.cockpit-pane, .cockpit-row') !== null`)); i++) await sleep(250)
  await openSettings()

  // The page: no banner, every section shaped alike, the column where it was.
  const titles: string[] = await ev(`[...document.querySelectorAll('.cockpit-settings-nav__item')].map((b) => b.textContent.trim())`)
  check('eleven sections', titles.length === 11, titles.join(', '))
  const lefts = new Set<number>()
  const bad: string[] = []
  for (const title of titles) {
    await nav(title)
    if (await ev(`document.querySelector('.cockpit-sbanner, .cockpit-snew') !== null`)) bad.push(`${title}: a banner or mark`)
    lefts.add(await ev(`Math.round(document.querySelector('.cockpit-settings-content__inner').getBoundingClientRect().left)`))
    if (title !== 'Dashboard') {
      if (!(await ev(`(document.querySelector('.cockpit-settings-content__lead')?.textContent ?? '').length > 0`))) bad.push(`${title}: no lead`)
      if (!(await ev(`document.querySelector('.cockpit-settings-content details.cockpit-sdetails > summary')?.textContent === 'Details'`))) bad.push(`${title}: no Details`)
      if (!(await ev(`(document.querySelector('.cockpit-settings-content .cockpit-sgroup .cockpit-sgroup__title')?.textContent ?? '').length > 0`))) bad.push(`${title}: first card untitled`)
    }
    await shot(`section-${title.toLowerCase()}`)
  }
  check('no banner or mark, and each section has a lead, a titled first card and Details', bad.length === 0, bad.join('; '))
  check('the centred column does not move between sections', lefts.size === 1, [...lefts].join(' / '))

  await nav('Checks')
  check('the auto-run row keeps its safety words in view', await ev(`(() => { const t = document.querySelector('.cockpit-settings-content [data-setting="checks-auto-run"]')?.textContent ?? ''; return t.includes('sandbox') && t.includes('every project') && !document.querySelector('.cockpit-settings-content [data-setting="checks-auto-run"]').closest('details') })()`))
  await ev(`[...document.querySelectorAll('.cockpit-settings-content button')].find((b) => b.textContent === 'Open Notifications').click()`)
  check('Open Notifications lands on that row', await waitFor(`document.querySelector('.cockpit-settings-content h2')?.textContent === 'Notifications' && document.querySelector('[data-setting="notify-check-fail"]') !== null`))
  check('"When tests fail" is on by default', (await switchState('When tests fail')) === 'true')
  await shot('notifications')
  await nav('Presets')
  check('presets, with none, say what they are for', await ev(`document.querySelector('.cockpit-settings-content')?.textContent.includes('No presets yet') ?? false`))
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('.cockpit-settings-page')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await waitFor(`document.querySelector('.cockpit-settings-page') === null`)

  // The alert: a real failing check on a scratch session, with the window "away".
  client = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
  workspaceId = ((await client.call('workspace.list')) as Array<{ id: string }>)[0]!.id
  cw('config', 'untrust')
  const trust = cw('config', 'trust')
  check('the scratch project trusts its sentinel command', trust.code === 0, trust.err.trim())
  await client.call('session.new', { workspaceId, name: NAME })
  await sleep(2500)
  await ev('window.__alerts = []; window.__away = true')
  const first = cw('check', NAME)
  check('the check fails', first.code === 1, first.err.trim())
  await waitFor(`window.__alerts.length > 0`, 10000)
  await sleep(2500)
  let seen = await alerts()
  check('exactly one alert for the failing run', seen.length === 1, JSON.stringify(seen))
  check('its title names the session and the failure', seen[0]?.[0]?.endsWith(': tests failed') === true && seen[0]?.[0]?.startsWith(NAME) === true, seen[0]?.[0])
  check('its body is the exit code and time, never the output', /^exit \d+, [\d.]+s$/.test(seen[0]?.[1] ?? '') && !(seen[0]?.[1] ?? '').includes('missing'), seen[0]?.[1])

  cw('check', NAME)
  await waitFor(`window.__alerts.length > 1`, 10000)
  await sleep(1500)
  seen = await alerts()
  check('a second failing run is announced again', seen.length === 2, `${seen.length} alerts`)

  await send('Page.reload')
  await waitFor(`document.querySelector('.cockpit-row') !== null`, 15000)
  await sleep(3500)
  seen = await alerts()
  check('after a reload nothing already told is announced again', seen.length === 0, `${seen.length} alerts`)

  await ev('window.__away = false')
  cw('check', NAME)
  await sleep(5000)
  check('with the window in front a new failing run raises none', (await alerts()).length === 0)

  await openSettings()
  await nav('Notifications')
  await ev(`document.querySelector('[role=switch][aria-label="When tests fail"]').click()`)
  switchedOff = true
  await ev('window.__away = true')
  cw('check', NAME)
  await sleep(5000)
  check('with the switch off a new failing run raises none', (await alerts()).length === 0)
  await ev(`document.querySelector('[role=switch][aria-label="When tests fail"]').click()`)
  switchedOff = false
  check('the switch is back on', (await switchState('When tests fail')) === 'true')

} finally {
  console.log(report.join('\n'))
  if (switchedOff) await ev(`document.querySelector('[role=switch][aria-label="When tests fail"]')?.click()`).catch(() => undefined)
  if (client) await client.call('session.kill', { workspaceId, idOrName: NAME, removeWorktree: true }).catch(() => undefined)
  cw('config', 'untrust')
}
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
