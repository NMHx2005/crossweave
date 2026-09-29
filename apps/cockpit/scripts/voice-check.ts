#!/usr/bin/env bun
/**
 * Voice input, end to end over CDP, with a synthetic microphone and stub commands:
 * record → the recording reaches the transcribe command as a real WAV → the text lands in
 * the draft → Send types it into the focused pane; and refinement is absent until switched on,
 * then shows a proposal beside the draft that only Accept applies.
 *
 * getUserMedia is replaced in the page by an oscillator stream: on macOS Electron asks the
 * operating system for the microphone even with Chromium's fake device, and a test must not
 * raise that prompt. The recorder, the WAV encoder, the IPC and the commands are all real.
 * Run the app with a scratch HOME (settings are the user's file) and COCKPIT_FAKE_MIC=1,
 * which skips only the app's own request for the macOS permission:
 *
 *   HOME=/tmp/cwhome COCKPIT_FAKE_MIC=1 COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . \
 *     --remote-debugging-port=9333 &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo COCKPIT_DEBUG_PORT=9333 \
 *     bun apps/cockpit/scripts/voice-check.ts [screenshot-dir]
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = process.env['COCKPIT_DEBUG_PORT'] ?? '9222'
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const HOME = process.env['HOME'] ?? ''
const SHOTS = process.argv[2]
const SETTINGS = join(HOME, '.crossweave', 'settings.json')
const STUBS = join(HOME, 'voice-stubs')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const report: string[] = []
const fail = (m: string): never => { console.error(report.join('\n')); console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (m: string): void => { report.push(`ok  ${m}`) }

// Stub programs: the "transcriber" proves it got a real WAV, the "refiner" proves it got the draft on stdin.
mkdirSync(STUBS, { recursive: true })
const transcriber = join(STUBS, 'transcribe.sh')
const refiner = join(STUBS, 'refine.sh')
const evidence = join(STUBS, 'evidence.txt')
writeFileSync(transcriber, `#!/bin/bash
f="$1"
bytes=$(wc -c < "$f" | tr -d ' ')
magic=$(head -c 4 "$f")
rate=$(od -An -t u4 -j 24 -N 4 "$f" | tr -d ' ')
echo "lang=$2 bytes=$bytes magic=$magic rate=$rate" > ${JSON.stringify(evidence)}
[ "$magic" = "RIFF" ] && [ "$bytes" -gt 20000 ] || { echo "not a wav" >&2; exit 3; }
echo "  khong xoa file, chi dieu tra thoi  "
`)
writeFileSync(refiner, `#!/bin/bash
input=$(cat)
echo "$input" > ${JSON.stringify(join(STUBS, 'refine-input.txt'))}
printf '# Objective\\nInvestigate only\\n\\n# Said\\n%s\\n' "$(echo "$input" | tail -n 1)"
`)
chmodSync(transcriber, 0o755)
chmodSync(refiner, 0o755)

const writeVoice = (voice: Record<string, unknown>): void => {
  const current = existsSync(SETTINGS) ? (JSON.parse(readFileSync(SETTINGS, 'utf8')) as Record<string, unknown>) : {}
  mkdirSync(join(HOME, '.crossweave'), { recursive: true })
  writeFileSync(SETTINGS, `${JSON.stringify({ ...current, voice }, null, 2)}\n`, { mode: 0o600 })
}
writeVoice({
  transcribeCommand: `${transcriber} {audio} {language}`,
  language: 'vi',
  snippets: [{ name: 'Investigate first', text: 'Investigate before changing any code.' }],
})

const { connectOrStart } = await import(`${REPO}/src/client/rpc-client.ts`)
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
const waitFor = async (expr: string, what: string, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await evaluate(expr)) return
    await sleep(100)
  }
  const seen = await evaluate(`document.querySelector('.cockpit-voice')?.innerText ?? '(no composer)'`)
  fail(`timed out waiting for ${what}. The composer shows: ${JSON.stringify(seen)}`)
}
const shot = async (name: string): Promise<void> => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const r = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data as string, 'base64'))
}
const btn = (label: string): string => `[...document.querySelectorAll('.cockpit-voice button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))`

for (let i = 0; i < 40 && !(await evaluate(`document.querySelector('.cockpit-pane') !== null`)); i++) await sleep(250)
const paneName = String(await evaluate(`document.querySelector('.cockpit-stage__body:not([hidden]) .cockpit-pane').getAttribute('aria-label')`)).split(' ')[0]!

// A tone in place of the microphone.
await evaluate(`(() => {
  const ctx = new AudioContext()
  const osc = ctx.createOscillator()
  const dest = ctx.createMediaStreamDestination()
  osc.connect(dest)
  osc.start()
  navigator.mediaDevices.getUserMedia = async () => dest.stream
})()`)

// 1. Opens from the mic button and starts recording at once.
await evaluate(`document.querySelector('button[aria-label="Voice input"]').click()`)
await waitFor(`document.querySelector('.cockpit-voice') !== null`, 'the composer')
await waitFor(`${btn('■ Stop')} !== undefined`, 'recording to start')
ok('the mic button opens the composer and starts recording')
await shot('recording')

// 2. Refinement does not exist while it is off.
if ((await evaluate(`${btn('Refine')} !== undefined`)) === true) fail('a Refine button is shown while refinement is off')
ok('no Refine control while the switch is off (the default)')

// 3. Stop → transcribe: the command received a real WAV and its text is in the draft.
await sleep(2500)
await evaluate(`${btn('■ Stop')}.click()`)
await waitFor(`document.querySelector('.cockpit-voice__draft').value.length > 0`, 'the transcript in the draft', 15000)
const draft = await evaluate(`document.querySelector('.cockpit-voice__draft').value`)
if (draft !== 'khong xoa file, chi dieu tra thoi') fail(`draft is ${JSON.stringify(draft)}`)
const seen = readFileSync(evidence, 'utf8').trim()
if (!/lang=vi bytes=\d+ magic=RIFF rate=16000/.test(seen)) fail(`the command received: ${seen}`)
ok(`the command received a 16 kHz WAV (${seen}) and its text is in the draft`)
await shot('draft')

// 4. A snippet is added on its own paragraph.
await evaluate(`${btn('Investigate first')}.click()`)
const withSnippet = await evaluate(`document.querySelector('.cockpit-voice__draft').value`)
if (withSnippet !== 'khong xoa file, chi dieu tra thoi\n\nInvestigate before changing any code.') fail(`with snippet: ${JSON.stringify(withSnippet)}`)
ok('a snippet lands on its own paragraph')

// 5. Send types it into the focused pane, and the draft is emptied.
const client = await connectOrStart(ROOT)
const workspaces = (await client.call('workspace.list')) as Array<{ id: string; rootPath: string }>
let got = ''
client.onNotification((m: string, p: { chunk?: string }) => { if (m === 'session.data' && typeof p.chunk === 'string') got += p.chunk })
await client.call('session.attach', { workspaceId: workspaces[0]!.id, idOrName: paneName })
await sleep(500)
got = ''
await evaluate(`${btn('Send')}.click()`)
await sleep(1200)
if (!got.includes('khong xoa file')) fail(`the pane's shell did not receive the draft: ${JSON.stringify(got.slice(-200))}`)
if ((await evaluate(`document.querySelector('.cockpit-voice__draft').value`)) !== '') fail('the draft was not emptied after Send')
ok('Send types the draft into the focused pane and empties the draft')

// 6. Refinement: switched on in settings, the button appears; it proposes; only Accept applies.
await evaluate(`document.querySelector('button[aria-label="Close voice input"]').click()`)
writeVoice({
  transcribeCommand: `${transcriber} {audio} {language}`,
  language: 'vi',
  refine: { enabled: true, command: refiner },
})
await evaluate(`document.querySelector('button[aria-label="Voice input"]').click()`)
await waitFor(`${btn('Refine')} !== undefined`, 'the Refine button once it is switched on')
await waitFor(`${btn('■ Stop')} !== undefined`, 'recording')
await sleep(2200)
await evaluate(`${btn('■ Stop')}.click()`)
await waitFor(`document.querySelector('.cockpit-voice__draft').value.length > 0`, 'the transcript', 15000)
await evaluate(`${btn('Refine')}.click()`)
await waitFor(`document.querySelector('.cockpit-voice__proposal') !== null`, 'the proposal')
const stillRaw = await evaluate(`document.querySelector('.cockpit-voice__draft').value`)
if (stillRaw !== 'khong xoa file, chi dieu tra thoi') fail(`the draft changed before Accept: ${JSON.stringify(stillRaw)}`)
const stdin = readFileSync(join(STUBS, 'refine-input.txt'), 'utf8')
if (!stdin.includes('do not add requirements') || !stdin.includes('khong xoa file')) fail(`the refine command got: ${stdin.slice(0, 200)}`)
ok('Refine shows a proposal beside the draft; the draft is untouched, and the command got the instruction and the draft')
await shot('proposal')
await evaluate(`${btn('Accept')}.click()`)
const accepted = await evaluate(`document.querySelector('.cockpit-voice__draft').value`)
if (!String(accepted).startsWith('# Objective')) fail(`after Accept: ${JSON.stringify(accepted)}`)
ok('Accept replaces the draft with the refined prompt')

console.log(report.join('\n'))
process.exit(0)
