import { describe, expect, test } from 'bun:test'
import { deliverText } from '../src/lib/paste-delivery'
import type { SendTarget } from '../src/lib/prompt-send'

const target = (over: Partial<SendTarget> = {}): SendTarget => ({ id: 's1', name: 'api', running: true, agent: 'claude', ...over })
const TEXT = 'first line\nsecond line'

describe('deliverText', () => {
  test('an agent gets one bracketed paste and never an Enter, and the person is told what was promised', async () => {
    const sent: Array<[string, string]> = []
    const out = await deliverText({ text: TEXT, target: target(), send: async (id, data) => { sent.push([id, data]) }, done: 'Pasted it' })
    expect(out).toEqual({ ok: true, message: 'Pasted it' })
    expect(sent).toEqual([['s1', `\x1b[200~${TEXT}\x1b[201~`]])
  })
  test('a plain shell would run each line: refused, nothing sent', async () => {
    let calls = 0
    const out = await deliverText({ text: TEXT, target: target({ agent: null }), send: async () => { calls++ }, done: 'x' })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('Not sent to api')
    expect(calls).toBe(0)
  })
  test('a closed shell, and an empty text, are refused', async () => {
    expect((await deliverText({ text: TEXT, target: target({ running: false }), send: async () => undefined, done: 'x' })).message).toContain('closed')
    expect((await deliverText({ text: '  \n ', target: target(), send: async () => undefined, done: 'x' })).ok).toBe(false)
  })
  test('a failing send is reported plainly', async () => {
    const out = await deliverText({ text: TEXT, target: target(), done: 'x', send: async () => { throw new Error("Error invoking remote method 'x': SESSION_GONE: no such session") } })
    expect(out).toEqual({ ok: false, message: 'SESSION_GONE: no such session' })
  })
  test('an end-of-paste sequence inside the text cannot close the paste early', async () => {
    let data = ''
    await deliverText({ text: 'a\x1b[201~echo pwned\nb', target: target(), send: async (_id, d) => { data = d }, done: 'x' })
    expect(data.indexOf('\x1b[201~')).toBe(data.length - '\x1b[201~'.length)
  })
})
