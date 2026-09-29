#!/usr/bin/env bun
/**
 * Terminal persistence end to end with a REAL daemon: with it on, an extra terminal survives a
 * daemon restart under the same id, replays its earlier output above a new shell and is marked
 * restored, and the state files are private; with it off (the default) nothing comes back.
 * Run with a scratch HOME (the setting lives in the user's settings file):
 *
 *   HOME=/tmp/cwhome bun apps/cockpit/scripts/persist-check.ts [/path/to/scratch/git/repo]
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const HOME = process.env['HOME'] ?? ''
const ROOT = process.argv[2] ?? join(process.env['TMPDIR'] ?? '/tmp', 'cw-persist-repo')
const { connectOrStart } = await import(`${REPO}/src/client/rpc-client.ts`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const report: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => { report.push(`${ok ? 'ok ' : 'BAD'} ${name}${extra ? ' — ' + extra : ''}`) }

const run = (cmd: string[]): void => { Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'ignore', stderr: 'ignore' }) }
if (!existsSync(join(ROOT, '.git'))) {
  mkdirSync(ROOT, { recursive: true })
  run(['git', 'init', '-q', '-b', 'main', '.'])
  run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
}
const setPersistence = (on: boolean): void => {
  mkdirSync(join(HOME, '.crossweave'), { recursive: true })
  writeFileSync(join(HOME, '.crossweave', 'settings.json'), JSON.stringify({ editor: { kind: 'vscode' }, launchers: [], layouts: {}, ...(on ? { persistence: { terminals: true } } : {}) }), { mode: 0o600 })
}

async function cycle(persistence: boolean): Promise<void> {
  const label = persistence ? 'persistence ON' : 'persistence OFF (the default)'
  setPersistence(persistence)
  let client = await connectOrStart(ROOT)
  const workspaceId = ((await client.call('workspace.init', {})) as { id: string }).id
  const sessions = (await client.call('session.list', { workspaceId })) as Array<{ name: string }>
  if (!sessions.some((s) => s.name === `s-${persistence ? 'on' : 'off'}`)) {
    await client.call('session.new', { workspaceId, name: `s-${persistence ? 'on' : 'off'}`, worktree: true })
    await client.call('session.start', { workspaceId, idOrName: `s-${persistence ? 'on' : 'off'}` })
  }
  const name = `s-${persistence ? 'on' : 'off'}`
  const opened = (await client.call('terminal.open', { workspaceId, idOrName: name })) as { terminalId: string }
  await client.call('terminal.attach', { workspaceId, terminalId: opened.terminalId })
  await sleep(600)
  await client.call('terminal.input', { workspaceId, terminalId: opened.terminalId, data: 'echo MARK_$((40+2))_END\r' })
  await sleep(1000)

  // stop the daemon the way `cw daemon stop` does, then start a new one
  await client.call('daemon.shutdown', {}).catch(() => undefined)
  client.close()
  await sleep(1500)
  client = await connectOrStart(ROOT)
  const after = (await client.call('terminal.list', { workspaceId })) as Array<{ terminalId: string; restored?: boolean }>
  const back = after.find((t) => t.terminalId === opened.terminalId)

  if (persistence) {
    check(`${label}: the terminal is back under the SAME id`, back !== undefined, opened.terminalId)
    check(`${label}: it is marked restored`, back?.restored === true)
    let got = ''
    client.onNotification((m: string, p: { chunk?: string }) => { if (m === 'terminal.data' && typeof p.chunk === 'string') got += p.chunk })
    if (back) await client.call('terminal.attach', { workspaceId, terminalId: back.terminalId })
    await sleep(600)
    check(`${label}: its earlier output is replayed`, got.includes('MARK_42_END'))
    check(`${label}: it says the shell is a new one`, /new shell/i.test(got))
    check(`${label}: it starts with a terminal reset`, got.startsWith('\x1bc'))
    const dbMode = statSync(join(ROOT, '.crossweave', 'state.db')).mode & 0o777
    check(`${label}: state.db is private`, dbMode === 0o600, dbMode.toString(8))
    const dirMode = statSync(join(ROOT, '.crossweave')).mode & 0o777
    check(`${label}: .crossweave is 0700`, dirMode === 0o700, dirMode.toString(8))
    // closing it deletes the row: it is not back after another restart
    await client.call('terminal.close', { workspaceId, terminalId: opened.terminalId }).catch(() => undefined)
  } else {
    check(`${label}: nothing comes back`, back === undefined)
  }
  await client.call('daemon.shutdown', {}).catch(() => undefined)
  client.close()
  await sleep(1200)
}

await cycle(false)
await cycle(true)
console.log(report.join('\n'))
process.exit(report.some((l) => l.startsWith('BAD')) ? 1 : 0)
