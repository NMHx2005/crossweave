import { describe, expect, test } from 'bun:test'
import { RendererBridge } from '../electron/renderer-bridge'

function setup(over: { window?: boolean; timeoutMs?: number } = {}) {
  const sent: Array<{ event: string; payload: any }> = []
  let n = 0
  const bridge = new RendererBridge({
    send: (event, payload) => { if (over.window === false) return false; sent.push({ event, payload }); return true },
    timeoutMs: over.timeoutMs ?? 1000,
    newId: () => `id_${++n}`,
  })
  return { bridge, sent }
}
const codeOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'resolved' } catch (e) { return (e as { code?: string }).code ?? 'no-code' } }

describe('RendererBridge', () => {
  test('sends the request to the window with an id it made, and resolves with the renderer\'s answer', async () => {
    const { bridge, sent } = setup()
    const asked = bridge.ask('pane.list', { a: 1 }, { projectRoot: '/p', workspaceId: 'ws_1' })
    expect(sent).toEqual([{ event: 'cockpit.bridge', payload: { id: 'id_1', kind: 'pane.list', params: { a: 1 }, projectRoot: '/p' } }])
    bridge.reply({ id: 'id_1', ok: true, result: { tabs: [] } })
    expect(await asked).toEqual({ tabs: [] })
  })

  test('a renderer error keeps its code and message', async () => {
    const { bridge } = setup()
    const asked = bridge.ask('pane.close', {}, { projectRoot: '/p', workspaceId: 'w' })
    bridge.reply({ id: 'id_1', ok: false, code: 'PANE_DENIED', message: 'The person did not allow it' })
    await expect(asked).rejects.toMatchObject({ code: 'PANE_DENIED', message: 'The person did not allow it' })
  })

  test('a malformed error code becomes BRIDGE_HANDLER_FAILED with a fixed sentence', async () => {
    const { bridge } = setup()
    const asked = bridge.ask('pane.close', {}, { projectRoot: '/p', workspaceId: 'w' })
    bridge.reply({ id: 'id_1', ok: false, code: 'lowercase code', message: 'Error: at /Users/x/secret.ts:1' })
    const err = await asked.catch((e) => e)
    expect(err.code).toBe('BRIDGE_HANDLER_FAILED')
    expect(err.message).not.toContain('secret')
  })

  test('answers once: the first settles, a second and an unknown id are ignored', async () => {
    const { bridge } = setup()
    const asked = bridge.ask('pane.list', {}, { projectRoot: '/p', workspaceId: 'w' })
    bridge.reply({ id: 'id_1', ok: true, result: 'first' })
    bridge.reply({ id: 'id_1', ok: true, result: 'second' })
    bridge.reply({ id: 'made-up', ok: true, result: 'forged' })
    expect(await asked).toBe('first')
  })

  test('only an id main issued can be answered: a guess settles nothing', async () => {
    const { bridge } = setup({ timeoutMs: 30 })
    const asked = bridge.ask('pane.list', {}, { projectRoot: '/p', workspaceId: 'w' })
    bridge.reply({ id: 'id_2', ok: true, result: 'guess' })
    expect(await codeOf(asked)).toBe('BRIDGE_TIMEOUT')
  })

  test('no window: BRIDGE_NO_WINDOW at once, and nothing is left waiting', async () => {
    const { bridge } = setup({ window: false })
    expect(await codeOf(bridge.ask('pane.list', {}, { projectRoot: '/p', workspaceId: 'w' }))).toBe('BRIDGE_NO_WINDOW')
    expect(bridge.pending()).toBe(0)
  })

  test('no answer in time: BRIDGE_TIMEOUT, the waiter is freed, and a late answer is ignored', async () => {
    const { bridge } = setup({ timeoutMs: 20 })
    const asked = bridge.ask('pane.list', {}, { projectRoot: '/p', workspaceId: 'w' })
    expect(await codeOf(asked)).toBe('BRIDGE_TIMEOUT')
    expect(bridge.pending()).toBe(0)
    expect(() => bridge.reply({ id: 'id_1', ok: true, result: 'late' })).not.toThrow()
  })

  test('a reply that is not an object is ignored', () => {
    const { bridge } = setup()
    for (const junk of [null, undefined, 'x', 5, [], { ok: true }]) expect(() => bridge.reply(junk as never)).not.toThrow()
  })
})
