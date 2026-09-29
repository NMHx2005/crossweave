#!/usr/bin/env bun
/**
 * Terminal throughput benchmark: how much the daemon→client hop and the renderer cost
 * under a flood, and whether interactive echo stays instant. Run once per stage
 * (baseline, +coalesce, +WebGL) and compare the rows — the point is the deltas.
 *
 * The app must be open with a debug port, a project root, and a running session whose
 * shell is at a prompt (the flood is typed into it):
 *
 *   COCKPIT_PROJECT_ROOT=/path/to/repo "…/crossweave Cockpit" --remote-debugging-port=9222 &
 *   COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/bench-terminal.ts <label>
 *
 * Reported per stage:
 *   notifications / bytes   what this client received for the flood (coalescing shrinks the first)
 *   to last line            daemon-side: keystroke sent → marker line arrived
 *   renderer settle         CDP: until the page's main thread stopped working (parsing + drawing)
 *   echo p50 / p95          one keystroke → its echo arriving, idle shell (leading edge keeps it ~0 added)
 * Coalescing is not backpressure: if "renderer settle" dominates "to last line", xterm's
 * parser — not IPC — is the bottleneck, and that is the honest result.
 */
const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9222'
const LABEL = process.argv[2] ?? 'unlabelled'
const LINES = Number(process.env['BENCH_LINES'] ?? '100000')

const { connectOrStart } = await import(`${REPO}/src/client/rpc-client.ts`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1) }

const client = await connectOrStart(ROOT)
type Ws = { id: string; rootPath: string }
const strip = (p: string): string => p.replace(/^\/private/, '')
const workspace = ((await client.call('workspace.list')) as Ws[]).find((w) => strip(w.rootPath) === strip(ROOT))
if (!workspace) fail(`no workspace for ${ROOT}`)
const sessions = (await client.call('session.list', { workspaceId: workspace!.id })) as Array<{ name: string; status: string }>
const target = sessions.find((s) => s.status === 'running')
if (!target) fail('no running session; start one first')
const ref = { workspaceId: workspace!.id, idOrName: target!.name }

let notifications = 0
let bytes = 0
let tail = ''
let onChunk: (() => void) | undefined
client.onNotification((method: string, params: unknown) => {
  const p = params as { chunk?: string }
  if (method !== 'session.data' || typeof p.chunk !== 'string') return
  notifications++
  bytes += p.chunk.length
  tail = (tail + p.chunk).slice(-200)
  onChunk?.()
})
await client.call('session.attach', ref)
await sleep(1500)

// Optional renderer half: only when a debug port answers.
let cdp: { metric(): Promise<number> } | undefined
try {
  const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
  const page = targets.find((t) => t.type === 'page')
  if (page) {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve) => ws.addEventListener('open', resolve))
    let seq = 0
    const call = (method: string): Promise<{ metrics?: Array<{ name: string; value: number }> }> => {
      const id = ++seq
      return new Promise((resolve) => {
        const on = (e: MessageEvent): void => {
          const msg = JSON.parse(String(e.data)) as { id?: number; result?: never }
          if (msg.id !== id) return
          ws.removeEventListener('message', on)
          resolve((msg.result ?? {}) as { metrics?: Array<{ name: string; value: number }> })
        }
        ws.addEventListener('message', on)
        ws.send(JSON.stringify({ id, method }))
      })
    }
    await call('Performance.enable')
    cdp = { metric: async () => (await call('Performance.getMetrics')).metrics?.find((m) => m.name === 'TaskDuration')?.value ?? 0 }
  }
} catch {
  // No debug port: the daemon-side numbers still stand.
}

const waitFor = (test: () => boolean, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    const deadline = Date.now() + ms
    const check = (): void => {
      if (test()) { onChunk = undefined; resolve(true); return }
      if (Date.now() > deadline) { onChunk = undefined; resolve(false); return }
    }
    onChunk = check
    const poll = setInterval(() => { check(); if (onChunk === undefined) clearInterval(poll) }, 5)
    check()
  })

// Echo latency on an idle shell: a printable key, then its erase.
const echo: number[] = []
for (let i = 0; i < 30; i++) {
  await sleep(150)
  tail = ''
  const t0 = performance.now()
  await client.call('session.input', { ...ref, data: 'a' })
  if (!(await waitFor(() => tail.includes('a'), 2000))) fail('no echo for a keystroke — is the shell at a prompt?')
  echo.push(performance.now() - t0)
  await client.call('session.input', { ...ref, data: '\x7f' })
}
echo.sort((a, b) => a - b)
const pct = (q: number): number => echo[Math.min(echo.length - 1, Math.floor(q * echo.length))]!

// The flood. The marker is built by the shell ($((…))), so the typed command line —
// which the shell echoes — cannot contain it: only the real output can.
await sleep(500)
notifications = 0
bytes = 0
tail = ''
const before = (await cdp?.metric()) ?? 0
const start = performance.now()
await client.call('session.input', { ...ref, data: `seq 1 ${LINES}; echo CWBENCH_$((40+2))_END\r` })
if (!(await waitFor(() => tail.includes('CWBENCH_42_END'), 120_000))) fail('the marker never arrived')
const lastLine = performance.now() - start
const notes = notifications
const received = bytes

let settle: number | undefined
if (cdp) {
  let last = await cdp.metric()
  let quietSince = performance.now()
  for (;;) {
    await sleep(100)
    const now = await cdp.metric()
    if (now - last > 0.005) quietSince = performance.now() // >5 ms of main-thread work in 100 ms
    last = now
    if (performance.now() - quietSince > 400) break
    if (performance.now() - start > 180_000) break
  }
  settle = quietSince - start
}
const busy = cdp ? ((await cdp.metric()) - before).toFixed(2) : 'n/a'

console.log(
  [
    `stage: ${LABEL}`,
    `  flood: seq 1 ${LINES}  (${received} bytes)`,
    `  notifications:     ${notes}`,
    `  to last line:      ${lastLine.toFixed(0)} ms`,
    `  renderer settle:   ${settle === undefined ? 'n/a (no debug port)' : `${settle.toFixed(0)} ms`}   main-thread busy ${busy} s`,
    `  echo p50 / p95:    ${pct(0.5).toFixed(1)} / ${pct(0.95).toFixed(1)} ms`,
  ].join('\n'),
)
client.close()
process.exit(0)
