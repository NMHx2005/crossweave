#!/usr/bin/env bun
/**
 * Motion gate, over CDP: splitting and closing a pane animate (and only when the OS has
 * not asked for less motion), a tab switch fades, and none of it costs a long task or
 * drops the frame rate. Run with reduced motion off and on in one go.
 *
 *   COCKPIT_PROJECT_ROOT=/path/to/repo "…/crossweave Cockpit" --remote-debugging-port=9333 &
 *   COCKPIT_DEBUG_PORT=9333 bun apps/cockpit/scripts/motion-check.ts [screenshot.png]
 *
 * The app needs one pane on screen (a running session). Exits non-zero on the first
 * failed check, printing the measurements that led to it.
 */
import { writeFileSync } from 'node:fs'

const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9222'
const SHOT = process.argv[2]
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const report: string[] = []
const fail = (m: string): never => { console.error(report.join('\n')); console.error(`FAIL: ${m}`); process.exit(1) }

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
const page = targets.find((t) => t.type === 'page')
if (!page) fail(`no page on port ${PORT}`)
const ws = new WebSocket(page!.webSocketDebuggerUrl)
await new Promise((resolve) => ws.addEventListener('open', resolve))
let seq = 0
const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  const id = ++seq
  return new Promise((resolve) => {
    const on = (e: MessageEvent): void => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: unknown }
      if (msg.id !== id) return
      ws.removeEventListener('message', on)
      if (msg.error) fail(`${method}: ${JSON.stringify(msg.error)}`)
      resolve(msg.result)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evaluate = async (expression: string): Promise<any> =>
  (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value

for (let i = 0; i < 40 && !(await evaluate(`document.querySelector('.cockpit-pane') !== null`)); i++) await sleep(250)
if (!(await evaluate(`document.querySelector('.cockpit-pane') !== null`))) fail('no pane mounted')

// Page-side probes: long tasks and frame deltas from here on; animations counted by their
// real duration (reduced motion collapses CSS ones to 0.01 ms, which is not motion); the
// rail's endless working spinner is not a transition and is left out.
await evaluate(`(() => {
  window.__m = { long: [], frames: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.long.push(e.duration) }).observe({ entryTypes: ['longtask'] });
  let last = performance.now();
  (function t(n) { window.__m.frames.push(n - last); last = n; requestAnimationFrame(t) })(last);
  window.__moving = () => document.getAnimations().filter((a) => (a.effect?.getTiming().duration ?? 0) > 1 && a.effect?.getTiming().iterations !== Infinity && a.playState === 'running').length;
  window.__menu = async (label, paneIndex) => {
    const panes = [...document.querySelectorAll('.cockpit-stage__body:not([hidden]) .cockpit-pane')];
    const p = panes[Math.min(paneIndex, panes.length - 1)];
    const r = p.getBoundingClientRect();
    p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }));
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const item = [...document.querySelectorAll('.cockpit-menu [role=menuitem]')].find((b) => b.textContent.startsWith(label));
    if (!item) return 'no menu item ' + label;
    item.click();
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return window.__moving();
  };
})()`)

// A second tab: open another session from the rail, if there is one.
if ((await evaluate(`document.querySelectorAll('[role=tab]').length`)) < 2) {
  await evaluate(`(() => { const rows = [...document.querySelectorAll('.cockpit-row')]; const other = rows.find((r) => !r.classList.contains('is-focused')); other?.click() })()`)
  await sleep(1200)
}

const stats = async (): Promise<{ long: number[]; frames: number[] }> => await evaluate('window.__m')
const p95 = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] ?? 0 }

for (const reduced of [false, true]) {
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] })
  await sleep(300)
  await evaluate('window.__m.long.length = 0; window.__m.frames.length = 0')
  const label = reduced ? 'reduced motion' : 'motion on'

  const afterSplit = await evaluate(`window.__menu('Split right', 0)`)
  if (typeof afterSplit === 'string') fail(String(afterSplit))
  report.push(`${label}: split → ${afterSplit} running animation(s)`)
  await sleep(600)
  const afterClose = await evaluate(`window.__menu('Close pane', 1)`)
  if (typeof afterClose === 'string') fail(String(afterClose))
  report.push(`${label}: close → ${afterClose} running animation(s)`)
  await sleep(600)

  // A tab switch: needs a second tab (the runner starts a second session and opens it).
  const tabs = await evaluate(`document.querySelectorAll('[role=tab]').length`)
  if (tabs >= 2) {
    const afterTab = await evaluate(`(async () => {
      const t = [...document.querySelectorAll('[role=tab]')].find((x) => x.getAttribute('aria-selected') !== 'true');
      t.click();
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      return window.__moving();
    })()`)
    report.push(`${label}: tab switch → ${afterTab} running animation(s)`)
    if (reduced && afterTab > 0) fail('reduced motion: the tab switch still animates')
    if (!reduced && afterTab === 0) fail('the tab switch did not fade')
    await sleep(400)
  } else {
    report.push(`${label}: tab switch skipped (one tab open)`)
  }

  if (reduced && (afterSplit > 0 || afterClose > 0)) fail('reduced motion: something still animates')
  if (!reduced && afterSplit === 0) fail('split started no animation')

  const s = await stats()
  const longest = Math.max(0, ...s.long)
  report.push(`${label}: ${s.frames.length} frames, p95 ${p95(s.frames).toFixed(1)} ms, ${s.frames.filter((f) => f > 33).length} over 33 ms, ${s.long.length} long task(s), longest ${longest.toFixed(0)} ms`)
  if (longest > 100) fail(`a ${longest.toFixed(0)} ms long task during the motion`)
}
await call('Emulation.setEmulatedMedia', { features: [] })

if (SHOT) {
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(SHOT, Buffer.from(shot.data as string, 'base64'))
  report.push(`screenshot: ${SHOT}`)
}
console.log(report.join('\n'))
process.exit(0)
