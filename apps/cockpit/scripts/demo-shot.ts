#!/usr/bin/env bun
/**
 * Demo screenshots for a social post, with NO real data.
 *
 * It seeds a throwaway repository and drives the RUNNING cockpit over CDP: creates
 * sessions named after a made-up project, prints an invented agent transcript into
 * their panes, marks one row "done" and one "asking", and writes PNGs to a folder.
 * Nothing from a real project ever reaches the screen, so a shot is safe to publish.
 *
 * Usage:
 *
 *   # 1. make the scratch repository (once; safe to re-run)
 *   bun apps/cockpit/scripts/demo-shot.ts seed ~/cw-demo/acme-api
 *
 *   # 2. open the app on it, on a scratch HOME (never a real project)
 *   HOME=~/cw-demo/home COCKPIT_PROJECT_ROOT=~/cw-demo/acme-api \
 *     node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . \
 *     --remote-debugging-port=9333 --user-data-dir=~/cw-demo/ud &
 *
 *   # 3. shoot
 *   HOME=~/cw-demo/home COCKPIT_PROJECT_ROOT=~/cw-demo/acme-api \
 *     bun apps/cockpit/scripts/demo-shot.ts --out ~/cw-demo/shots
 *
 * Options: --out DIR (default <project>/demo-shots) · --width N · --height N ·
 *          --shots a,b,c (hero, done, asking, panes, dashboard, composer) · --port N
 *
 * Run OUTSIDE a restricted sandbox (pty + unix socket), like the other *-check.ts scripts.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The made-up product the shots show: session name, the invented task, and the row's mark. */
const DEMO = [
  { name: 'auth-refactor', task: 'rewrite the login flow', signal: { kind: 'done', message: 'login flow rewritten — tests green' } as const },
  { name: 'rate-limits', task: 'add burst limits to the API', signal: { kind: 'ask', message: 'raise the burst cap to 200/s?' } as const },
  { name: 'docs-cleanup', task: 'tighten the README', signal: null },
]

/** A fake agent screen, printed into a pane. Raw so the shell's printf escapes survive. */
const SCENE = String.raw`#!/usr/bin/env bash
# Printed into a demo pane so a screenshot shows a plausible agent session.
# It exists only in the scratch repo 'demo-shot seed' makes — safe to delete.
name="$1"; task="$2"

# A small, real change so the rail has a commit to land.
f="src/$name.ts"; [ -f "$f" ] || f="src/misc.ts"
printf '\n// %s: %s\n' "$name" "$task" >> "$f"
git add -A >/dev/null 2>&1
git commit -q -m "wip($name): $task" >/dev/null 2>&1

printf '\033[2J\033[H'
printf '\033[1m claude\033[0m  \033[2m%s\033[0m\n\n' "$task"
printf '  \033[32m●\033[0m Read  %s\n' "$f"
printf '  \033[32m●\033[0m Edit  %s  \033[2m(+18 -6)\033[0m\n' "$f"
printf '  \033[32m●\033[0m Bash  bun test tests/%s.test.ts\n\n' "$name"
printf '  \033[32m✓\033[0m 12 passed  \033[2m(0.41s)\033[0m\n\n'
printf '  \033[33m⠹\033[0m Working…  \033[2m(esc to interrupt)\033[0m\n\n'
sleep 3600
`

const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr).trim()}`)
}

/** A scratch repository that looks like a small product, with every demo name present. */
function seed(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  mkdirSync(join(dir, '.crossweave-demo'), { recursive: true })
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndemo-shots/\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acme-api', version: '0.3.0', type: 'module', scripts: { test: 'bun test' } }, null, 2) + '\n')
  writeFileSync(join(dir, 'README.md'), '# acme-api\n\nA made-up API used only to generate crossweave screenshots.\n')
  writeFileSync(join(dir, 'src/index.ts'), 'export const app = (): string => "acme"\n')
  writeFileSync(join(dir, 'src/misc.ts'), 'export const misc = 0\n')
  for (const s of DEMO) writeFileSync(join(dir, `src/${s.name}.ts`), `export function ${camel(s.name)}(): number {\n  return 0\n}\n`)
  for (const s of DEMO) writeFileSync(join(dir, `tests/${s.name}.test.ts`), `import { test, expect } from 'bun:test'\n\ntest('${s.name}', () => {\n  expect(1).toBe(1)\n})\n`)
  // bash's printf only decodes \uXXXX in a UTF-8 locale; the pty shell may not have one, so ship the glyphs literally.
  writeFileSync(join(dir, '.crossweave-demo', 'scene.sh'), SCENE.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16))))
  chmodSync(join(dir, '.crossweave-demo', 'scene.sh'), 0o755)

  if (!existsSync(join(dir, '.git'))) git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 'Demo')
  git(dir, 'config', 'user.email', 'demo@example.com')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: initial scaffold')
  writeFileSync(join(dir, 'src/router.ts'), 'export const routes: string[] = []\n')
  git(dir, 'add', '-A')
  try { git(dir, 'commit', '-q', '-m', 'feat: add a router and the first modules') } catch { /* already seeded: nothing new to commit */ }
}

if (argv[0] === 'seed') {
  const dir = resolve(argv[1] ?? 'acme-api')
  seed(dir)
  console.log(`seeded ${dir}`)
  console.log('\nnow open the app on it (scratch HOME) and run this script again without "seed":')
  console.log(`  HOME=${resolve(dir, '..', 'home')} COCKPIT_PROJECT_ROOT=${dir} \\`)
  console.log('    node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9333 --user-data-dir=/tmp/cw-demo-ud &')
  process.exit(0)
}
if (argv[0] === '--help' || argv[0] === '-h') {
  console.log('demo-shot: seed <dir> | [--out DIR] [--width N] [--height N] [--shots hero,done,asking,panes,dashboard,composer] [--port N]')
  process.exit(0)
}

// ---- shoot ----

const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = Number(flag('--port') ?? process.env['COCKPIT_DEBUG_PORT'] ?? '9333')
const OUT = resolve(flag('--out') ?? process.env['DEMO_OUT'] ?? join(ROOT, 'demo-shots'))
const WIDTH = Number(flag('--width') ?? '1440')
const HEIGHT = Number(flag('--height') ?? '900')
const WANT = new Set((flag('--shots') ?? 'hero,asking,done,panes,dashboard,composer').split(',').map((s) => s.trim()).filter(Boolean))
const want = (name: string): boolean => WANT.has(name)

const sock = join(ROOT, '.crossweave', 'daemon.sock')
if (!existsSync(sock)) {
  console.error(`No daemon socket at ${sock}.\nOpen the app on the scratch project first (see this file's header), then run again.`)
  process.exit(2)
}
if (!existsSync(join(ROOT, '.crossweave-demo', 'scene.sh'))) {
  console.error(`No ${join(ROOT, '.crossweave-demo', 'scene.sh')} — run "demo-shot.ts seed ${ROOT}" first.`)
  process.exit(2)
}

const { DaemonClient } = await import(`${REPO}/src/client/rpc-client.ts`)

// CDP: talk to the window the way the other scripts do, and take real screenshots of it.
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
const page = targets.find((t) => t.type === 'page')
if (page === undefined) { console.error(`No page target on 127.0.0.1:${PORT} — is the app running with --remote-debugging-port=${PORT}?`); process.exit(2) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  const id = ++seq
  return new Promise((resolveP) => {
    const on = (e: MessageEvent): void => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown }
      if (m.id !== id) return
      ws.removeEventListener('message', on)
      resolveP(m.result)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const ev = async (expression: string): Promise<any> => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value

const client = await DaemonClient.connect(sock)
const workspaceId = ((await client.call('workspace.list')) as Array<{ id: string }>)[0]?.id
if (workspaceId === undefined) { console.error('No workspace in this daemon — open the project in the app once.'); process.exit(2) }

mkdirSync(OUT, { recursive: true })
let written = 0
async function shot(name: string): Promise<void> {
  const res = await call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const b64 = res?.data as string | undefined
  if (b64 === undefined) throw new Error('Page.captureScreenshot returned no data')
  const file = join(OUT, `${name}.png`)
  writeFileSync(file, Buffer.from(b64, 'base64'))
  written++
  console.log(`  wrote ${file}`)
}
const focus = async (name: string): Promise<void> => {
  await ev(`(() => { const r = [...document.querySelectorAll('.cockpit-row')].find((x) => x.querySelector('.cockpit-row__title')?.textContent?.includes(${JSON.stringify(name)})); r?.click(); return !!r })()`)
  // Wait for the pane to mount and replay its pty buffer before the next shot.
  for (let i = 0; i < 20 && (await ev(`document.querySelector('.cockpit-pane') !== null`)) !== true; i++) await sleep(400)
  await sleep(1200)
}
const clickNav = (label: string): Promise<unknown> => ev(`[...document.querySelectorAll('.cockpit-settings-nav__item')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`)
function cw(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([process.execPath, `${REPO}/src/cli/index.ts`, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env })
  return (async () => ({ out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text(), code: await proc.exited }))()
}

// A fixed, retina-sized viewport, so every shot is the same shape.
await call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false })
await sleep(600)

// 1. The sessions: real worktrees in the scratch repo, each with a shell.
let rows = (await client.call('session.list', { workspaceId })) as Array<{ id: string; name: string; status?: string }>
for (const spec of DEMO) {
  let row = rows.find((r) => r.name === spec.name)
  if (row === undefined) {
    const created = (await client.call('session.new', { workspaceId, name: spec.name })) as { id: string }
    row = { id: created.id, name: spec.name }
  }
  if (row.status !== 'running' && row.status !== 'waiting') await client.call('session.start', { workspaceId, idOrName: row.id }).catch(() => undefined)
  await sleep(1500)
}
for (let i = 0; i < 60; i++) { rows = (await client.call('session.list', { workspaceId })) as typeof rows; if (DEMO.every((s) => rows.some((r) => r.name === s.name))) break; await sleep(500) }

// 2. Paint each pane with the invented transcript (it clears the screen, so the command is never seen).
for (const spec of DEMO) {
  await client.call('session.input', { workspaceId, idOrName: spec.name, data: `bash ./.crossweave-demo/scene.sh ${spec.name} "${spec.task}"\r` }).catch(() => undefined)
  await sleep(1200)
}

// 3. Exact rail marks: one "done", one "asking" (needs the session running).
for (const spec of DEMO) {
  if (spec.signal === null) continue
  await client.call('session.notify', { workspaceId, idOrName: spec.name, kind: spec.signal.kind, message: spec.signal.message }).catch(() => undefined)
}
await sleep(1000)

// 4. Shots.
if (want('hero')) { await focus('docs-cleanup'); await shot('01-hero') }
if (want('done')) { await focus('auth-refactor'); await shot('02-done') }
if (want('asking')) { await focus('rate-limits'); await shot('03-asking') }
if (want('panes')) {
  await focus('auth-refactor')
  await cw('pane', 'split', 'right')
  await sleep(2500)
  const terms = (await client.call('terminal.list', { workspaceId })) as Array<{ terminalId: string; sessionName: string }>
  const last = terms[terms.length - 1]
  if (last !== undefined) await client.call('terminal.input', { workspaceId, terminalId: last.terminalId, data: `bash ./.crossweave-demo/scene.sh rate-limits "add burst limits to the API"\r` }).catch(() => undefined)
  await sleep(2000)
  await shot('04-panes')
}
// The overlays go last: the stage behind them no longer matters, so no need to close one to open the next.
if (want('composer')) {
  await ev(`document.querySelector('button[aria-label="Prompt"]')?.click()`)
  await sleep(1200)
  await ev(`(() => { const a = document.querySelector('.cockpit-prompt__draft'); if (!a) return; a.value = 'Add rate limiting to the public API — 100 req/min per key, a 429 with Retry-After, and a test.'; a.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(600)
  await shot('05-composer')
}
if (want('dashboard')) {
  await ev(`document.querySelector('button[aria-label="Settings"]')?.click()`)
  await sleep(1200)
  await clickNav('Dashboard')
  await sleep(3000)
  await shot('06-dashboard')
}

console.log(`\ndone — ${written} shot(s) in ${OUT}`)
console.log('The demo sessions are still running in the scratch repo; kill them or remove the folder when finished.')
client.close()
process.exit(0)
