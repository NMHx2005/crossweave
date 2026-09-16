#!/usr/bin/env bun
/**
 * Best-effort attach capture when a real Cockpit GUI / claude session is unavailable.
 * Connects to cwd, attaches the first running session, and reports whether
 * session.data still carries CSI (the M9 strip-ANSI failure mode).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { connectOrStart } from '../../../src/client/rpc-client.ts'
import { encodeSessionData } from '../electron/daemon-bridge.ts'
import { decodeSessionData } from '../src/lib/session-data.ts'
import { parseSessionList } from '../src/lib/sessions.ts'

const projectRoot = process.env.COCKPIT_PROJECT_ROOT ?? process.cwd()
const socketPath = join(projectRoot, '.crossweave', 'daemon.sock')

function stripCsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

const client = await connectOrStart(projectRoot)
try {
  const workspace = await client.call<{ id: string }>('workspace.init', {})
  const sessions = parseSessionList(
    await client.call('session.list', { workspaceId: workspace.id }),
  )
  const running = sessions.find((s) => s.status === 'running') ?? sessions[0]
  if (!running) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: 'no sessions',
          projectRoot,
          daemonSock: existsSync(socketPath),
        },
        null,
        2,
      ),
    )
    process.exit(2)
  }

  const chunks: string[] = []
  client.onNotification((method, params) => {
    if (method !== 'session.data') return
    const decoded = decodeSessionData(encodeSessionData(params))
    if (!decoded || decoded.sessionId !== running.id) return
    const text =
      typeof decoded.chunk === 'string' ? decoded.chunk : new TextDecoder().decode(decoded.chunk)
    chunks.push(text)
  })

  try {
    await client.call('session.attach', { workspaceId: workspace.id, idOrName: running.id })
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: 'attach failed',
          session: running,
          error: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      ),
    )
    process.exit(3)
  }

  await new Promise((r) => setTimeout(r, 1500))
  const joined = chunks.join('')
  const hasCsi = joined.includes('\x1b[')
  const newlineCount = (joined.match(/\n/g) ?? []).length
  console.log(
    JSON.stringify(
      {
        ok: true,
        session: running,
        chunkCount: chunks.length,
        bytes: joined.length,
        hasCsi,
        newlineCount,
        strippedWouldDropCsi: hasCsi && !stripCsi(joined).includes('\x1b['),
        sample: JSON.stringify(joined.slice(0, 200)),
      },
      null,
      2,
    ),
  )
} finally {
  client.close()
}
