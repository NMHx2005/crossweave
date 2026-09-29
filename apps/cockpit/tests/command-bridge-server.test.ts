import { describe, expect, test } from 'bun:test'
import { CrossweaveError } from '../../../src/core/errors.js'
import { CommandBridgeServer } from '../electron/command-bridge'

const ctx = { projectRoot: '/p', workspaceId: 'ws_1' }

describe('CommandBridgeServer', () => {
  test('serves the kinds it was given, and lists them for registration', () => {
    const s = new CommandBridgeServer()
    s.serve('pane.ping', () => 'pong')
    s.serve('pane.list', () => [])
    expect(s.kinds().sort()).toEqual(['pane.list', 'pane.ping'])
  })

  test('a handler\'s result is the response', async () => {
    const s = new CommandBridgeServer()
    s.serve('pane.ping', (params, c) => ({ pong: true, params, root: c.projectRoot }))
    expect(await s.handle({ id: 'br_1', kind: 'pane.ping', params: { a: 1 } }, ctx)).toEqual({ ok: true, result: { pong: true, params: { a: 1 }, root: '/p' } })
  })

  test('an async handler is awaited', async () => {
    const s = new CommandBridgeServer()
    s.serve('pane.ping', async () => { await new Promise((r) => setTimeout(r, 5)); return 'late' })
    expect(await s.handle({ id: 'x', kind: 'pane.ping', params: {} }, ctx)).toEqual({ ok: true, result: 'late' })
  })

  test('a kind nobody serves is refused, not run', async () => {
    const s = new CommandBridgeServer()
    expect(await s.handle({ id: 'x', kind: 'pane.split', params: {} }, ctx)).toMatchObject({ ok: false, code: 'BRIDGE_UNSUPPORTED_KIND' })
  })

  test('a CrossweaveError keeps its code and its message', async () => {
    const s = new CommandBridgeServer()
    s.serve('pane.ping', () => { throw new CrossweaveError('PANE_NOT_FOUND', 'no such pane') })
    expect(await s.handle({ id: 'x', kind: 'pane.ping', params: {} }, ctx)).toEqual({ ok: false, code: 'PANE_NOT_FOUND', message: 'no such pane' })
  })

  // Fail closed: an unexpected error must not leak a stack, a path or an internal message
  // to a shell command (which may belong to an agent that was prompt-injected).
  test('any other error becomes BRIDGE_HANDLER_FAILED with no detail from the error', async () => {
    const s = new CommandBridgeServer()
    s.serve('pane.ping', () => { throw new Error('ENOENT /Users/me/secret/path at Object.<anonymous> (/x/y.ts:1:1)') })
    const r = await s.handle({ id: 'x', kind: 'pane.ping', params: {} }, ctx)
    expect(r).toMatchObject({ ok: false, code: 'BRIDGE_HANDLER_FAILED' })
    expect(JSON.stringify(r)).not.toContain('secret')
    expect(JSON.stringify(r)).not.toContain('/x/y.ts')
  })

  test('an async rejection is handled the same way', async () => {
    const s = new CommandBridgeServer()
    s.serve('pane.ping', async () => { throw new Error('boom') })
    expect(await s.handle({ id: 'x', kind: 'pane.ping', params: {} }, ctx)).toMatchObject({ ok: false, code: 'BRIDGE_HANDLER_FAILED' })
  })

  test('serving the same kind twice is a programming error, not a silent replacement', () => {
    const s = new CommandBridgeServer()
    s.serve('pane.ping', () => 1)
    expect(() => s.serve('pane.ping', () => 2)).toThrow()
  })
})
