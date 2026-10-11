#!/usr/bin/env bun
/**
 * Records the demo clip for the website (website/public/media/demo.mp4): the REAL cockpit, driven over CDP on a scratch HOME and
 * a scratch repository, filmed frame by frame on an in-page stage (a floating window on a backdrop, a camera that zooms and pans to the
 * action, a visible cursor with click ripples, constant-size captions and cards), then encoded with ffmpeg.
 *
 * What is real: the sessions, their worktrees and branches, the commits, the daemon's trial merges and their verdicts, the land. What
 * is scripted: the agent screens (a script prints them into each shell) and the status marks (sent with `cw notify`'s RPC). The clip
 * says so beside it on the page.
 *
 *   bun apps/cockpit/scripts/site-video.ts prepare             # scratch repo, scene script, the starting commit
 *   HOME=<scratch>/home COCKPIT_PROJECT_ROOT=<scratch>/acme-api Electron . --remote-debugging-port=9334 --user-data-dir=<scratch>/ud &
 *   bun apps/cockpit/scripts/site-video.ts reset               # between takes: remove the sessions, reset main to the starting commit
 *   bun apps/cockpit/scripts/site-video.ts record [--draft]    # frames -> <scratch>/frames; --draft is small and fast, for timing
 *   bun apps/cockpit/scripts/site-video.ts encode [--draft]    # frames -> mp4, poster, stills, share card (needs ffmpeg)
 *
 * Needs ffmpeg. Run OUTSIDE a restricted sandbox (pty and unix socket). It refuses to run unless HOME is a scratch one.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { userInfo } from 'node:os'
import { APPLY_FRAME, READ_TOKENS, STAGE_H, STAGE_W, WIN_H, WIN_W, WIN_X, WIN_Y, installStage, type FrameState } from './site-video/stage'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const mode = process.argv[2] ?? ''
const draft = process.argv.includes('--draft')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const ROOT = resolve(process.env['COCKPIT_PROJECT_ROOT'] ?? '')
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9334'
const SCRATCH = resolve(ROOT, '..')
const FRAMES = join(SCRATCH, draft ? 'frames-draft' : 'frames')
const OUT = join(SCRATCH, 'out')

// ---- guards ----------------------------------------------------------------------------------------------------------------------
const refuse = (why: string): never => { console.error(`REFUSED: ${why}`); process.exit(2) }
if (!['prepare', 'reset', 'record', 'encode', 'og'].includes(mode)) refuse('usage: site-video.ts prepare|reset|record|encode|og [--draft]')
if (process.env['COCKPIT_PROJECT_ROOT'] === undefined) refuse('set COCKPIT_PROJECT_ROOT to the scratch project')
if (process.env['HOME'] === undefined || basename(process.env['HOME'].replace(/\/$/, '')) === userInfo().username) refuse('HOME looks like the real home directory; use a scratch HOME')
if (!/cw-scratch/.test(ROOT)) refuse('the project must live under a directory named cw-scratch*')

// ---- the story ------------------------------------------------------------------------------------------------------------------
const FPS = draft ? 12 : 30
const DPR = draft ? 1 : 1.5
const SESSIONS = [
  { name: 'docs-cleanup', task: 'tighten the README', file: 'README.md', done: 'README tightened, tests green' },
  { name: 'rate-limits', task: 'raise the burst cap to 200/s', file: 'src/limits.ts', ask: 'raise the cap to 200/s?' },
  { name: 'burst-cap', task: 'cap bursts at 250/s', file: 'src/limits.ts' },
] as const

const SCENE = String.raw`#!/usr/bin/env bash
# Printed into a pane for the website's demo clip: a real change and commit on this session's branch, then a plausible agent screen.
name="$1"; task="$2"; file="$3"; mood="$4"
case "$name" in
  rate-limits) sed -i.bak 's/BURST = 100/BURST = 200/' src/limits.ts && rm -f src/limits.ts.bak ;;
  burst-cap)   sed -i.bak 's/BURST = 100/BURST = 250/' src/limits.ts && rm -f src/limits.ts.bak ;;
  docs-cleanup) printf '\nSee docs/ for the full guide.\n' >> README.md; mkdir -p .github/workflows; printf 'name: docs\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n' > .github/workflows/docs.yml ;;
esac
git add -A >/dev/null 2>&1
git commit -q -m "wip($name): $task" >/dev/null 2>&1

printf '\033[2J\033[H'
printf '\033[1m claude\033[0m  \033[2m%s\033[0m\n\n' "$task"
printf '  \033[32m\342\227\217\033[0m Read  %s\n' "$file"
printf '  \033[32m\342\227\217\033[0m Edit  %s  \033[2m(+1 -1)\033[0m\n' "$file"
printf '  \033[32m\342\227\217\033[0m Bash  bun test\n\n'
printf '  \033[32m\342\234\223\033[0m 12 passed  \033[2m(0.41s)\033[0m\n\n'
if [ "$mood" = "ask" ]; then
  printf '  \033[33m?\033[0m Raise the cap to 200/s?  \033[2m(y/n)\033[0m\n\n'
elif [ "$mood" = "done" ]; then
  printf '  \033[32m\342\234\223\033[0m Done\n\n'
else
  printf '  \033[33m\342\240\271\033[0m Working\342\200\246  \033[2m(esc to interrupt)\033[0m\n\n'
fi
sleep 3600
`

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr).trim()}`)
  return new TextDecoder().decode(p.stdout).trim()
}

async function prepare(): Promise<void> {
  if (!existsSync(join(ROOT, '.git'))) {
    Bun.spawnSync(['bun', join(REPO, 'apps/cockpit/scripts/demo-shot.ts'), 'seed', ROOT], { stdout: 'inherit', stderr: 'inherit' })
  }
  mkdirSync(join(ROOT, 'src'), { recursive: true })
  writeFileSync(join(ROOT, 'src/limits.ts'), 'export const BURST = 100\nexport const WINDOW_MS = 1000\n')
  mkdirSync(join(ROOT, '.crossweave-demo'), { recursive: true })
  writeFileSync(join(ROOT, '.crossweave-demo', 'video-scene.sh'), SCENE)
  chmodSync(join(ROOT, '.crossweave-demo', 'video-scene.sh'), 0o755)
  git(ROOT, 'add', '-A')
  try { git(ROOT, 'commit', '-q', '-m', 'chore: the starting point of the demo clip') } catch { /* already committed */ }
  try { git(ROOT, 'tag', '-f', 'video-start') } catch { /* tag exists */ }
  console.log(`prepared ${ROOT} (tag video-start at ${git(ROOT, 'rev-parse', '--short', 'video-start')})`)
}

// ---- CDP and the daemon ---------------------------------------------------------------------------------------------------------
async function connect(): Promise<{ send(method: string, params?: Record<string, unknown>): Promise<any>; ev(expression: string): Promise<any>; close(): void }> {
  const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
  const page = targets.find((t) => t.type === 'page')
  if (page === undefined) throw new Error(`no page on port ${PORT}: is the app running with --remote-debugging-port=${PORT}?`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let seq = 0
  const pending = new Map<number, (v: any) => void>()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown }
    if (m.id !== undefined) { pending.get(m.id)?.(m.result); pending.delete(m.id) }
  })
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolveP) => { const id = ++seq; pending.set(id, resolveP); ws.send(JSON.stringify({ id, method, params })) })
  const ev = async (expression: string): Promise<any> => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails !== undefined) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)}`)
    return r?.result?.value
  }
  return { send, ev, close: () => ws.close() }
}

async function daemon(): Promise<{ client: any; workspaceId: string }> {
  const { DaemonClient } = await import(`${REPO}/src/client/rpc-client.ts`)
  const sock = join(ROOT, '.crossweave', 'daemon.sock')
  if (!existsSync(sock)) throw new Error(`no daemon socket at ${sock}: open the app on the scratch project first`)
  const client = await DaemonClient.connect(sock)
  const workspaceId = ((await client.call('workspace.list')) as Array<{ id: string }>)[0]?.id
  if (workspaceId === undefined) throw new Error('no workspace in this daemon')
  return { client, workspaceId }
}

async function reset(): Promise<void> {
  const { client, workspaceId } = await daemon()
  const rows = (await client.call('session.list', { workspaceId })) as Array<{ id: string; name: string; status?: string }>
  for (const row of rows) {
    if (!SESSIONS.some((s) => s.name === row.name)) continue
    await client.call('session.kill', { workspaceId, idOrName: row.id, removeWorktree: true }).catch(() => undefined)
    await client.call('session.rm', { workspaceId, idOrName: row.id }).catch(() => undefined)
  }
  git(ROOT, 'reset', '--hard', 'video-start')
  for (const s of SESSIONS) { try { git(ROOT, 'branch', '-D', `cw/${s.name}`) } catch { /* not there */ } }
  console.log('reset: sessions removed, main back at video-start')
  client.close()
}

// ---- the timeline: data, not code -----------------------------------------------------------------------------------------------
type Point = { x: number; y: number }
/** A place on the screen: stage coordinates, or a CSS selector whose centre (plus an offset) is looked up when the cursor sets off. */
type Target = Point | { sel: string; text?: string; dx?: number; dy?: number }

interface CameraMove { at: number; dur: number; x: number; y: number; z: number }
interface CursorMove { at: number; dur: number; to: Target; arc?: number }
interface Click { at: number; target?: Target; button?: 'left' | 'right' }
interface Caption { id: string; step: number; text: string; from: number; to: number }
interface Card { id: string; from: number; to: number; fadeIn?: number; fadeOut?: number }
interface Action { at: number; name: string; run: () => Promise<void> }
interface Gate { at: number; name: string; until: () => Promise<boolean>; timeoutMs: number }

const ROW = (name: string): string => `.cockpit-row[title^="${name} — "]`

const camera: CameraMove[] = [
  { at: 0.0, dur: 2.6, x: 960, y: 540, z: 1.05 },
  { at: 2.8, dur: 1.2, x: 700, y: 470, z: 1.5 },
  { at: 9.6, dur: 1.4, x: 800, y: 470, z: 1.18 },
  { at: 16.8, dur: 1.4, x: 960, y: 520, z: 1.28 },
  { at: 24.0, dur: 1.4, x: 700, y: 470, z: 1.5 },
  { at: 31.2, dur: 1.2, x: 960, y: 520, z: 1.3 },
  { at: 33.9, dur: 1.4, x: 960, y: 540, z: 1.0 },
]

const cursor: CursorMove[] = [
  { at: 3.0, dur: 0.01, to: { x: 1250, y: 760 } },
  { at: 7.6, dur: 1.0, to: { sel: ROW('burst-cap'), dx: -20 }, arc: -60 },
  { at: 11.0, dur: 0.9, to: { sel: ROW('rate-limits'), dx: -20 }, arc: 40 },
  { at: 13.0, dur: 0.8, to: { sel: `${ROW('rate-limits')} .cockpit-status`, dx: 0 }, arc: -30 },
  { at: 15.0, dur: 0.8, to: { sel: ROW('docs-cleanup'), dx: 40 }, arc: 30 },
  { at: 17.4, dur: 0.8, to: { sel: ROW('docs-cleanup'), dx: 60 }, arc: -20 },
  { at: 19.0, dur: 0.7, to: { sel: '[role=menuitem]', text: 'Changes' } },
  { at: 22.2, dur: 0.7, to: { sel: 'button[aria-label="Changes"]', dx: 0 }, arc: -30 },
  { at: 23.3, dur: 0.6, to: { sel: ROW('rate-limits'), dx: -20 }, arc: 25 },
  { at: 25.2, dur: 1.0, to: { sel: `${ROW('rate-limits')} .cockpit-chip--conflict`, dx: 0 }, arc: 50 },
  { at: 27.0, dur: 0.9, to: { sel: `${ROW('burst-cap')} .cockpit-chip--conflict`, dx: 0 }, arc: -30 },
  { at: 28.8, dur: 0.9, to: { sel: `${ROW('docs-cleanup')} .cockpit-chip--ready`, dx: 0 }, arc: 40 },
]

const clicks: Click[] = []

const captions: Caption[] = [
  { id: 'cw-cap-1', step: 1, text: 'Each session is its own git worktree and shell', from: 3.8, to: 9.2 },
  { id: 'cw-cap-2', step: 2, text: 'The rail shows who is working, asking or done', from: 10.4, to: 16.0 },
  { id: 'cw-cap-3', step: 3, text: 'Review what a session changed before you land it', from: 17.8, to: 23.4 },
  { id: 'cw-cap-4', step: 4, text: 'Trial merges run in the background: one is clean, two collide', from: 24.4, to: 30.2 },
  { id: 'cw-cap-5', step: 5, text: 'Land the one that holds up', from: 31.4, to: 36.0 },
]

const cards: Card[] = [
  { id: 'cw-card-title', from: 0.0, to: 2.8, fadeIn: 0.01, fadeOut: 0.7 },
  { id: 'cw-card-end', from: 36.4, to: 41.0, fadeIn: 0.7, fadeOut: 0.6 },
]
const DURATION = 41.0
/** Which moments of the take stand for the poster and for the three steps of the home page (seconds). */
const STILLS = { poster: 21.5, steps: [7.5, 13.2, 25.5] } as const

const OVERLAY = `${captions.map((c) => `<div id="${c.id}" class="cw-caption"><b>${c.step}</b>${c.text}</div>`).join('')}
<div id="cw-card-title" class="cw-card" style="background:rgba(14,16,19,.88)"><img src="__ICON__" alt=""><h1>crossweave</h1><p>Many agents. One repo.</p></div>
<div id="cw-card-end" class="cw-card" style="background:rgba(14,16,19,.94)"><img src="__ICON__" alt=""><h1>Land what holds up.</h1><p>Free · MIT · macOS and Linux</p><p class="small">github.com/NMHx2005/crossweave</p></div>`

// ---- easing and state -----------------------------------------------------------------------------------------------------------
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const inOut = (v: number): number => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2)
const outExpo = (v: number): number => (v >= 1 ? 1 : 1 - Math.pow(2, -10 * v))

function cameraAt(t: number): { x: number; y: number; z: number } {
  let from = { x: 960, y: 540, z: 1 }
  for (const m of camera) {
    if (t < m.at) return from
    const to = { x: m.x, y: m.y, z: m.z }
    if (t >= m.at + m.dur) { from = to; continue }
    const e = inOut(clamp01((t - m.at) / m.dur))
    // Zoom in log space, so the same step looks the same size at any scale; the focus point follows the same curve.
    return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: Math.exp(Math.log(from.z) + (Math.log(to.z) - Math.log(from.z)) * e) }
  }
  return from
}

const toTranslate = (c: { x: number; y: number; z: number }): { tx: number; ty: number; z: number } => ({ tx: STAGE_W / 2 - c.x * c.z, ty: STAGE_H / 2 - c.y * c.z, z: c.z })

function fade(t: number, from: number, to: number, fin = 0.4, fout = 0.35): number {
  if (t < from || t > to) return 0
  return Math.min(clamp01((t - from) / fin), clamp01((to - t) / fout))
}

// ---- recording ------------------------------------------------------------------------------------------------------------------
async function record(): Promise<void> {
  const page = await connect()
  const { client, workspaceId } = await daemon()
  const { ev, send } = page

  mkdirSync(FRAMES, { recursive: true })
  for (const f of readdirSync(FRAMES)) rmSync(join(FRAMES, f), { force: true })

  await send('Page.enable')
  // The terminal's WebGL renderer draws nothing in a capture taken at a device scale other than 1 (the pane stays blank), so the
  // clip is filmed with the cockpit's own fallback, the DOM renderer, which is also vector-sharp under the camera's zoom. The cockpit
  // picks its renderer by `typeof WebGL2RenderingContext`; the script lives only as long as this connection.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.WebGL2RenderingContext = undefined' })
  // A fresh page, so nothing of a previous take (an installed stage, a focused pane) is left in it.
  await send('Page.reload', { ignoreCache: true })
  for (let i = 0; i < 40 && (await ev(`!!document.querySelector('.cockpit-row, .cockpit-welcome, #app > *')`).catch(() => false)) !== true; i++) await sleep(250)
  await sleep(2500)
  await send('Emulation.setDeviceMetricsOverride', { width: STAGE_W, height: STAGE_H, deviceScaleFactor: DPR, mobile: false })
  const tokens = JSON.parse(await ev(`JSON.stringify(${READ_TOKENS})`))
  const icon = `data:image/png;base64,${readFileSync(join(REPO, 'website/public/icon.png')).toString('base64')}`
  const installed = await ev(installStage(tokens, OVERLAY, icon))
  console.log('stage:', installed)
  await sleep(800)

  // Where something is, in stage coordinates, read from the page: its centre relative to the window, scaled back by the camera's zoom.
  const pointOf = async (target: Target): Promise<Point> => {
    if ('x' in target) return target
    const dx = target.dx ?? 0
    const dy = target.dy ?? 0
    const found = await ev(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(target.sel)})]; const el = ${target.text === undefined ? 'all[0]' : `all.find((x) => x.textContent.trim() === ${JSON.stringify(target.text)})`}; if (!el) return null; const r = el.getBoundingClientRect(); const w = document.getElementById('cw-win').getBoundingClientRect(); const k = w.width / ${WIN_W}; return { x: ${WIN_X} + ((r.left + r.width / 2) - w.left) / k, y: ${WIN_Y} + ((r.top + r.height / 2) - w.top) / k } })()`)
    if (found === null || found === undefined) throw new Error(`cursor target not found: ${target.sel}`)
    return { x: found.x + dx, y: found.y + dy }
  }

  const sessionRows = async (): Promise<string[]> => (await ev(`[...document.querySelectorAll('.cockpit-row')].map((r) => r.getAttribute('title')?.split(' — ')[0] ?? '')`)) as string[]
  const rowHas = (name: string, sel: string): Promise<boolean> => ev(`!!document.querySelector(${JSON.stringify(`${ROW(name)} ${sel}`)})`)
  const commitOn = (name: string): boolean => {
    try { return git(ROOT, 'log', '--oneline', `video-start..cw/${name}`).includes(`wip(${name})`) } catch { return false }
  }

  const actions: Action[] = [
    {
      at: 3.2,
      name: 'create the three sessions',
      run: async () => {
        for (const s of SESSIONS) {
          const created = (await client.call('session.new', { workspaceId, name: s.name })) as { id: string }
          await client.call('session.start', { workspaceId, idOrName: created.id })
          await sleep(900)
        }
      },
    },
    {
      at: 8.8,
      name: 'send each agent screen (a real commit, then a scripted transcript)',
      run: async () => {
        for (const s of SESSIONS) {
          const mood = 'ask' in s ? 'ask' : 'done' in s ? 'done' : 'work'
          // A shell that is still starting swallows what is typed into it, so the line is sent again until its commit is there.
          for (let attempt = 0; attempt < 5 && !commitOn(s.name); attempt++) {
            await client.call('session.input', { workspaceId, idOrName: s.name, data: `bash ./.crossweave-demo/video-scene.sh ${s.name} "${s.task}" ${s.file} ${mood}\r` })
            for (let i = 0; i < 20 && !commitOn(s.name); i++) await sleep(200)
          }
        }
      },
    },
    {
      // `land` refuses a running session ("stop it first"), so the agent that finished is stopped the way a person would (`cw session stop`): an idle session is still classified and can be landed.
      at: 24.3,
      name: 'stop docs-cleanup (idle, still classified, can be landed)',
      run: async () => {
        await client.call('session.stop', { workspaceId, idOrName: 'docs-cleanup' })
      },
    },
    {
      at: 10.5,
      name: 'send the status marks',
      run: async () => {
        for (const s of SESSIONS) {
          if ('ask' in s) await client.call('session.notify', { workspaceId, idOrName: s.name, kind: 'ask', message: s.ask })
          if ('done' in s) await client.call('session.notify', { workspaceId, idOrName: s.name, kind: 'done', message: s.done })
        }
      },
    },
  ]

  const gates: Gate[] = [
    { at: 7.4, name: 'three rows in the rail', timeoutMs: 40_000, until: async () => { const rows = await sessionRows(); return SESSIONS.every((s) => rows.includes(s.name)) } },
    { at: 10.4, name: 'a commit on every branch', timeoutMs: 40_000, until: async () => SESSIONS.every((s) => commitOn(s.name)) },
    { at: 14.4, name: 'the finished row says what it did', timeoutMs: 20_000, until: async () => (await ev(`document.querySelector('${ROW('docs-cleanup')}')?.textContent?.includes('README tightened') === true`)) === true },
    {
      at: 24.8,
      name: 'the daemon names one clean session and two that collide',
      timeoutMs: 90_000,
      until: async () => (await rowHas('docs-cleanup', '.cockpit-chip--ready')) && (await rowHas('rate-limits', '.cockpit-chip--conflict')) && (await rowHas('burst-cap', '.cockpit-chip--conflict')),
    },
  ]

  type Beat = { at: number; name: string; run: (cursorAt: Point) => Promise<void> }
  const beats: Beat[] = [
    { at: 8.6, name: 'open burst-cap', run: async (p) => { await click(p, 'left') } },
    { at: 11.9, name: 'open rate-limits', run: async (p) => { await click(p, 'left') } },
    { at: 18.3, name: 'right-click docs-cleanup', run: async (p) => { await click(p, 'right') } },
    {
      at: 19.7,
      name: 'choose Changes',
      run: async () => {
        const found = await ev(`(() => { const b = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === 'Changes'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
        if (found === null) throw new Error('the row menu has no Changes item')
        await mouse('mouseMoved', found.x, found.y)
        await sleep(120)
        await mouse('mousePressed', found.x, found.y)
        await mouse('mouseReleased', found.x, found.y)
        rippleAt = { t: now, x: (found.x - txNow) / zNow, y: (found.y - tyNow) / zNow }
      },
    },
    { at: 23.0, name: 'hide Changes', run: async (p) => { await click(p, 'left') } },
    { at: 23.95, name: 'back to rate-limits', run: async (p) => { await click(p, 'left') } },
    { at: 30.0, name: 'press Land on the clean session', run: async (p) => { await click(p, 'left') } },
    {
      at: 32.6,
      name: 'confirm the landing',
      run: async () => {
        const found = await ev(`(() => { const dlg = document.querySelector('.cockpit-confirm'); if (!dlg) return null; const b = [...dlg.querySelectorAll('button')].find((x) => /land/i.test(x.textContent) && !/cancel/i.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
        if (found === null) return
        await mouse('mouseMoved', found.x, found.y)
        await sleep(160)
        await mouse('mousePressed', found.x, found.y)
        await mouse('mouseReleased', found.x, found.y)
        rippleAt = { t: now, x: (found.x - txNow) / zNow, y: (found.y - tyNow) / zNow }
      },
    },
  ]

  // ---- the frame loop ----
  let now = 0
  let txNow = 0
  let tyNow = 0
  let zNow = 1
  let rippleAt: { t: number; x: number; y: number } | null = null
  let cursorPos: Point = { x: 1250, y: 760 }
  let cursorShown = false
  const resolved = new Map<CursorMove, { from: Point; to: Point }>()

  const mouse = (type: string, x: number, y: number): Promise<unknown> =>
    send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : mouseButton, buttons: type === 'mousePressed' ? (mouseButton === 'right' ? 2 : 1) : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
  let mouseButton: 'left' | 'right' = 'left'
  const click = async (stage: Point, button: 'left' | 'right'): Promise<void> => {
    mouseButton = button
    const x = stage.x * zNow + txNow
    const y = stage.y * zNow + tyNow
    await mouse('mouseMoved', x, y)
    await sleep(100)
    await mouse('mousePressed', x, y)
    await mouse('mouseReleased', x, y)
    rippleAt = { t: now, x: stage.x, y: stage.y }
    mouseButton = 'left'
  }

  const failures: string[] = []
  const settle = async (name: string, p: Promise<void>): Promise<void> => { try { await p } catch (e) { failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`) } }
  const started = new Set<Action>()
  const passed = new Set<Gate>()
  const fired = new Set<Beat>()
  const total = Math.round(DURATION * FPS)
  const t0 = performance.now()

  for (let i = 0; i < total; i++) {
    now = i / FPS

    for (const a of actions) if (!started.has(a) && now >= a.at) { started.add(a); console.log(`  ${now.toFixed(1)}s action: ${a.name}`); void settle(a.name, a.run()) }

    for (const g of gates) {
      if (passed.has(g) || now < g.at) continue
      const t1 = performance.now()
      let ok = false
      while (performance.now() - t1 < g.timeoutMs) { if (await g.until().catch(() => false)) { ok = true; break } await sleep(150) }
      passed.add(g)
      console.log(`  ${now.toFixed(1)}s gate: ${g.name}${ok ? '' : ' TIMED OUT'}${ok ? ` (held ${((performance.now() - t1) / 1000).toFixed(1)}s)` : ''}`)
      if (!ok) failures.push(`gate: ${g.name}`)
    }

    // camera
    const cam = toTranslate(cameraAt(now))
    txNow = cam.tx; tyNow = cam.ty; zNow = cam.z

    // cursor
    const latest = [...cursor].reverse().find((m) => now >= m.at)
    for (const m of cursor) {
      if (now < m.at) continue
      cursorShown = true
      if (!resolved.has(m)) resolved.set(m, { from: cursorPos, to: await pointOf(m.to).catch(() => cursorPos) })
      const r = resolved.get(m)!
      // A row can move while the cursor is on its way (the rail reorders when a session asks), so the move that is in force keeps
      // looking its target up; otherwise a click would land on whatever row took its place.
      if (m === latest && !('x' in m.to)) r.to = await pointOf(m.to).catch(() => r.to)
      const e = inOut(clamp01((now - m.at) / m.dur))
      const arc = (m.arc ?? 0) * Math.sin(Math.PI * e)
      cursorPos = { x: r.from.x + (r.to.x - r.from.x) * e, y: r.from.y + (r.to.y - r.from.y) * e + arc }
    }

    // beats (real clicks), at the cursor's current place
    for (const b of beats) if (!fired.has(b) && now >= b.at) { fired.add(b); console.log(`  ${now.toFixed(1)}s beat: ${b.name}`); await settle(b.name, b.run(cursorPos)); await sleep(60) }

    if (cursorShown) await mouse('mouseMoved', cursorPos.x * zNow + txNow, cursorPos.y * zNow + tyNow).catch(() => undefined)

    const state: FrameState = {
      camera: cam,
      cursor: { x: cursorPos.x, y: cursorPos.y, visible: cursorShown && now < 36.2 },
      ripple: rippleAt !== null && now - rippleAt.t < 0.6 ? { x: rippleAt.x, y: rippleAt.y, progress: outExpo((now - rippleAt.t) / 0.6) } : null,
      captions: captions.map((c) => ({ id: c.id, opacity: fade(now, c.from, c.to), lift: (1 - fade(now, c.from, c.to)) * 14 })),
      cards: cards.map((c) => ({ id: c.id, opacity: fade(now, c.from, c.to, c.fadeIn, c.fadeOut) })),
    }
    await ev(`(${APPLY_FRAME})(${JSON.stringify(state)})`)
    const shot = await send('Page.captureScreenshot', { format: draft ? 'jpeg' : 'png', quality: 80, fromSurface: true, optimizeForSpeed: true })
    writeFileSync(join(FRAMES, `${String(i).padStart(5, '0')}.${draft ? 'jpg' : 'png'}`), Buffer.from(shot.data as string, 'base64'))
    if (i % FPS === 0) console.log(`  frame ${i}/${total}  t=${now.toFixed(1)}s  (${((performance.now() - t0) / 1000).toFixed(0)}s elapsed)`)
  }

  console.log(failures.length === 0 ? 'recorded with no failures' : `FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  client.close()
  page.close()
  process.exit(failures.length === 0 ? 0 : 1)
}

// ---- editing --------------------------------------------------------------------------------------------------------------------
function ffmpeg(args: string[]): void {
  const p = Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], { stdout: 'inherit', stderr: 'inherit' })
  if (p.exitCode !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed`)
}

function encode(): void {
  mkdirSync(OUT, { recursive: true })
  const ext = draft ? 'jpg' : 'png'
  const n = readdirSync(FRAMES).filter((f) => f.endsWith(`.${ext}`)).length
  if (n === 0) throw new Error(`no frames in ${FRAMES}`)
  const out = join(OUT, draft ? 'demo-draft.mp4' : 'demo.mp4')
  const w = draft ? 960 : 1920
  const h = draft ? 540 : 1080
  // Fade in and out so the loop does not jump: the end card and the title card are both dark.
  const vf = `scale=${w}:${h}:flags=lanczos,fade=t=in:st=0:d=0.25,fade=t=out:st=${(n / FPS - 0.5).toFixed(2)}:d=0.5,format=yuv420p`
  ffmpeg(['-framerate', String(FPS), '-i', join(FRAMES, `%05d.${ext}`), '-vf', vf, '-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'slow', '-crf', draft ? '30' : '24', '-maxrate', '1.6M', '-bufsize', '3.2M', '-movflags', '+faststart', '-an', out])
  console.log(`wrote ${out} (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB, ${n} frames at ${FPS} fps)`)
  // A contact sheet for looking at the whole take at a glance.
  ffmpeg(['-i', out, '-vf', `fps=1/2,scale=320:-1,tile=6x${Math.ceil(n / FPS / 2 / 6)}`, '-frames:v', '1', join(OUT, draft ? 'sheet-draft.png' : 'sheet.png')])
  console.log(`wrote ${join(OUT, draft ? 'sheet-draft.png' : 'sheet.png')}`)
  if (draft) return
  // The poster and the three step pictures are frames of the take itself (lossless PNGs), picked by time.
  const frameAt = (t: number): string => join(FRAMES, `${String(Math.round(t * FPS)).padStart(5, '0')}.png`)
  ffmpeg(['-i', frameAt(STILLS.poster), '-vf', 'scale=1920:1080:flags=lanczos', '-q:v', '4', join(OUT, 'poster.jpg')])
  STILLS.steps.forEach((t, i) => ffmpeg(['-i', frameAt(t), '-vf', 'scale=1280:-1:flags=lanczos', '-compression_level', '9', join(OUT, `step-${i + 1}.png`)]))
  console.log(`wrote ${join(OUT, 'poster.jpg')} and step-1..${STILLS.steps.length}.png`)
}

/** The 1200x630 share card: the poster frame in a rounded frame beside the name and the line. Drawn by the running app (it needs a browser), so it is a mode of its own. */
async function shareCard(): Promise<void> {
  const page = await connect()
  const data = (file: string, type: string): string => `data:${type};base64,${readFileSync(file).toString('base64')}`
  const poster = data(join(OUT, 'poster.jpg'), 'image/jpeg')
  const icon = data(join(REPO, 'website/public/icon.png'), 'image/png')
  const markup = `<head><style>
html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#0e1013;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',system-ui,sans-serif;color:#f2f4f7}
.bg{position:absolute;inset:0;background:radial-gradient(700px 420px at 75% 40%,#1c2230 0%,#0e1013 70%)}
.t{position:absolute;left:64px;top:150px;width:470px}
.t img{width:72px;height:72px}.t h1{margin:18px 0 8px;font-size:72px;letter-spacing:-.03em}.t p{margin:0;font-size:36px;color:#c4cad4;line-height:1.2}.t small{display:block;margin-top:22px;font-size:24px;color:#8a919c}
.f{position:absolute;left:600px;top:110px;width:760px;height:427px;border-radius:14px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.1),0 30px 80px rgba(0,0,0,.6)}
.f img{width:100%;height:100%;display:block}
</style></head><body><div class="bg"></div><div class="t"><img src="${icon}" alt=""><h1>crossweave</h1><p>Many agents. One repo.</p><small>Land what holds up.</small></div><div class="f"><img src="${poster}" alt=""></div></body>`
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false })
  await page.ev(`document.documentElement.innerHTML = ${JSON.stringify(markup)}; true`)
  await sleep(800)
  const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  writeFileSync(join(OUT, 'og.png'), Buffer.from(shot.data as string, 'base64'))
  await page.send('Emulation.clearDeviceMetricsOverride')
  await page.send('Page.reload', { ignoreCache: true })
  console.log(`wrote ${join(OUT, 'og.png')}`)
  page.close()
  process.exit(0)
}

if (mode === 'prepare') await prepare()
else if (mode === 'og') await shareCard()
else if (mode === 'reset') await reset().then(() => process.exit(0))
else if (mode === 'record') await record()
else encode()
