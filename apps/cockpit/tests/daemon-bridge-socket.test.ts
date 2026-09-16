import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonClient } from '../../../src/client/rpc-client.ts'
import { createFrameDecoder, encodeFrame } from '../../../src/daemon/rpc.ts'
import { DaemonBridge } from '../electron/daemon-bridge'
import type { CockpitEvent } from '../electron/channels'

function startFakeDaemon(socketPath: string): Promise<{ server: Server; sockets: Socket[] }> {
  const sockets: Socket[] = []
  const server = createServer((sock) => {
    sockets.push(sock)
    sock.on(
      'data',
      createFrameDecoder((msg) => {
        const req = msg as { id?: number; method?: string }
        if (typeof req.id !== 'number' || typeof req.method !== 'string') return
        const result =
          req.method === 'workspace.init'
            ? { id: 'ws_1', name: 'demo', rootPath: '/tmp/demo' }
            : req.method === 'daemon.subscribe'
              ? { subscribed: true }
              : req.method === 'session.list'
                ? [{ id: 's1', name: 'alpha' }]
                : { ok: true }
        sock.write(encodeFrame({ jsonrpc: '2.0', id: req.id, result }))
      }),
    )
  })
  mkdirSync(join(socketPath, '..'), { recursive: true })
  return new Promise((resolve, reject) => {
    server.listen(socketPath, () => resolve({ server, sockets }))
    server.once('error', reject)
  })
}

describe('DaemonBridge + real DaemonClient socket', () => {
  let server: Server | undefined
  let client: DaemonClient | undefined

  afterEach(() => {
    client?.close()
    client = undefined
    if (server) {
      server.close()
      server = undefined
    }
  })

  test('forwards a tui.invalidate notification from the wire', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-sock-'))
    const socketPath = join(dir, 'daemon.sock')
    const fake = await startFakeDaemon(socketPath)
    server = fake.server
    client = await DaemonClient.connect(socketPath)

    const events: Array<{ event: CockpitEvent; payload: unknown }> = []
    const bridge = new DaemonBridge({
      connect: async () => client as DaemonClient,
      pickFolder: async () => undefined,
      loadSavedRoot: () => undefined,
      saveRoot: () => undefined,
      send: (event, payload) => events.push({ event, payload }),
    })

    await bridge.handle('workspace.ensure', { projectRoot: dir })
    const listed = await bridge.handle('session.list')
    expect(listed).toEqual([{ id: 's1', name: 'alpha' }])

    const sock = fake.sockets[0]
    expect(sock).toBeDefined()
    sock?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tui.invalidate', params: {} })}\n`)
    await new Promise((r) => setTimeout(r, 50))
    expect(events).toEqual([{ event: 'tui.invalidate', payload: {} }])
  })
})
