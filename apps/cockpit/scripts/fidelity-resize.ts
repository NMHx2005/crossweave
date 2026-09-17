#!/usr/bin/env bun
/**
 * Resize/focus half of the Task 4 fidelity gate, automated — the half that used to
 * be "wired and unit-tested, not GUI-exercised".
 *
 * What it proves, end to end: a viewport change reflows the pane, the pane's xterm
 * re-fits, `session.resize` reaches the PTY (the daemon streams agent redraw back),
 * and Tab lands keyboard focus inside the pane with a visible accent outline.
 *
 * Usage — the app must already be open with a debug port and a project root:
 *
 *   COCKPIT_PROJECT_ROOT=/path/to/repo \
 *     "apps/cockpit/release/mac-arm64/crossweave Cockpit.app/Contents/MacOS/crossweave Cockpit" \
 *     --remote-debugging-port=9222 &
 *   COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/fidelity-resize.ts
 *
 * Exits non-zero on the first check that fails, so it can be run by hand or by CI
 * on a machine that has a screen.
 */
const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9222'

const { connectOrStart } = await import(`${REPO}/src/client/rpc-client.ts`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Printed before exiting, so a failure shows the measurements that caused it. */
const report: string[] = []

function fail(message: string): never {
  if (report.length > 0) console.error(report.join('\n'))
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

const client = await connectOrStart(ROOT)
type Ws = { id: string; rootPath: string }
const workspace = ((await client.call('workspace.list')) as Ws[]).find((w) => w.rootPath.replace(/^\/private/, '') === ROOT.replace(/^\/private/, ''))
if (!workspace) fail(`no workspace for ${ROOT}`)
const sessions = (await client.call('session.list', { workspaceId: workspace!.id })) as Array<{ name: string; status: string }>
const target = sessions.find((s) => s.status === 'running')
if (!target) fail(`no running session in ${ROOT}; start one first`)

let pending = 0
client.onNotification((method: string, params: unknown) => {
  const p = params as { chunk?: string }
  if (method === 'session.data' && typeof p.chunk === 'string') pending += p.chunk.length
})
await client.call('session.attach', { workspaceId: workspace!.id, idOrName: target.name })
await sleep(1500)

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
const page = targets.find((t) => t.type === 'page')
if (!page) fail(`no page target on port ${PORT} — is the app running with --remote-debugging-port?`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve) => ws.addEventListener('open', resolve))
let seq = 0
const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  const id = ++seq
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent): void => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: unknown }
      if (msg.id !== id) return
      ws.removeEventListener('message', onMessage)
      if (msg.error) fail(`${method}: ${JSON.stringify(msg.error)}`)
      resolve(msg.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evaluate = async (expression: string): Promise<any> =>
  (await call('Runtime.evaluate', { expression, returnByValue: true })).result.value

/**
 * A freshly opened window lists its sessions before its first pane has mounted, and
 * measuring then produces a bogus baseline (which reads as "the fit addon is not
 * re-fitting"). Wait for the pane to exist first.
 */
for (let attempt = 0; attempt < 40; attempt += 1) {
  const mounted = await evaluate(`document.querySelector('.xterm-screen') !== null`)
  if (mounted === true) break
  if (attempt === 39) fail('no xterm pane mounted after 10s — is a running session attached?')
  await sleep(250)
}

const geometry = async (): Promise<{ win: number; pane: number; xterm: number }> =>
  JSON.parse(
    await evaluate(`JSON.stringify({
      win: window.innerWidth,
      pane: Math.round(document.querySelector('.cockpit-stage__pane').getBoundingClientRect().width),
      xterm: Math.round(document.querySelector('.xterm-screen').getBoundingClientRect().width),
    })`),
  )

let previous = await geometry()
report.push(`  viewport ${previous.win}px → pane ${previous.pane}px / xterm ${previous.xterm}px`)

for (const width of [1000, 1500]) {
  pending = 0
  await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(2500)
  const now = await geometry()
  report.push(`  viewport ${now.win}px → pane ${now.pane}px / xterm ${now.xterm}px  (${pending} bytes of agent redraw)`)
  if (now.win !== width) fail(`viewport override to ${width} did not take (got ${now.win})`)
  if (now.xterm >= previous.xterm && width < previous.win) fail('xterm did not shrink with its pane — the fit addon is not re-fitting')
  if (now.xterm <= previous.xterm && width > previous.win) fail('xterm did not grow with its pane — the fit addon is not re-fitting')
  if (pending === 0) fail('no redraw came back from the agent: session.resize never reached the PTY')
  previous = now
}
await call('Emulation.clearDeviceMetricsOverride')

const pressTab = async (): Promise<void> => {
  const base = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(400)
}
await pressTab()
const focus = JSON.parse(
  await evaluate(`(() => {
    const el = document.activeElement
    const cs = getComputedStyle(el)
    return JSON.stringify({ tag: el.tagName, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor })
  })()`),
)
report.push(`  Tab → focus ${focus.tag}, outline ${focus.outlineWidth} ${focus.outlineStyle} ${focus.outlineColor}`)
if (focus.outlineStyle === 'none' || focus.outlineWidth === '0px') fail('focused element has no visible focus ring')

console.log(`OK: resize + focus verified against ${ROOT}\n${report.join('\n')}`)
process.exit(0)
