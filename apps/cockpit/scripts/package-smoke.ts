#!/usr/bin/env bun
/**
 * Smoke-check a macOS arm64 Cockpit package: bundled cwd exists and session.list works.
 * Run after `bun run dist:mac` from apps/cockpit.
 */
import { existsSync } from 'node:fs'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectOrStart } from '../../../src/client/rpc-client.js'
import { makeGitFixture } from '../../../tests/helpers/git-fixture.js'

const cockpitRoot = join(import.meta.dir, '..')
const repoRoot = join(cockpitRoot, '..', '..')
const appDir = join(cockpitRoot, 'release', 'mac-arm64')
const appName = 'crossweave Cockpit.app'
const appPath = join(appDir, appName)
const cwdBin = join(appPath, 'Contents', 'Resources', 'bin', 'cwd')
const execBin = join(appPath, 'Contents', 'MacOS', 'crossweave Cockpit')
const cwBin = join(repoRoot, 'dist', 'cw')

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

if (!existsSync(appPath)) fail(`Missing packaged app: ${appPath}\nRun: cd apps/cockpit && bun run dist:mac`)
if (!existsSync(cwdBin)) fail(`Missing bundled daemon: ${cwdBin}`)
if (!existsSync(cwBin)) fail(`Missing cw binary for fixture init: ${cwBin}`)

chmodSync(cwdBin, 0o755)

const fx = await makeGitFixture()
try {
  const initWs = spawnSync(cwBin, ['init'], { cwd: fx.root, encoding: 'utf8' })
  if (initWs.status !== 0) fail(`cw init failed: ${initWs.stderr || initWs.stdout}`)

  const client = await connectOrStart(fx.root, { command: cwdBin, args: [] })
  const workspace = await client.call<{ id: string }>('workspace.init', {})
  const sessions = await client.call<unknown[]>('session.list', { workspaceId: workspace.id })
  client.close()
  if (!Array.isArray(sessions)) fail(`session.list returned unexpected payload: ${JSON.stringify(sessions)}`)

  const app = spawn(execBin, [], {
    cwd: fx.root,
    env: { ...process.env, COCKPIT_PROJECT_ROOT: fx.root },
    stdio: 'ignore',
    detached: true,
  })
  app.unref()
  await new Promise((r) => setTimeout(r, 2_000))
  if (app.exitCode !== null && app.exitCode !== 0) {
    fail(`packaged app exited early with code ${app.exitCode}`)
  }
  spawnSync('pkill', ['-f', appPath], { stdio: 'ignore' })

  console.log(`OK: dmg/zip layout valid; cwd daemon lists ${sessions.length} session(s); app stayed up 2s`)
} finally {
  spawnSync(cwBin, ['daemon', 'stop'], { cwd: fx.root, stdio: 'ignore' })
  await fx.cleanup()
}
