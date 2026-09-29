import { describe, expect, test } from 'bun:test'
import { cleanPromptText, planSend, type SendTarget } from '../src/lib/prompt-send'

const ESC = '\x1b'
const agent = (id: string, name = id): SendTarget => ({ id, name, running: true, agent: 'claude' })
const shell = (id: string): SendTarget => ({ id, name: id, running: true, agent: null })

describe('cleanPromptText', () => {
  test('line endings become \\n, trailing space goes, tabs and newlines stay', () => {
    expect(cleanPromptText('a\r\nb\rc\t d  \n\n')).toBe('a\nb\nc\t d')
  })

  test('escape sequences and other control characters are stripped: a prompt is text, never keystrokes', () => {
    expect(cleanPromptText(`x${ESC}[201~echo pwned\x07\x00y\x7f`)).toBe('x[201~echo pwnedy')
    expect(cleanPromptText('a\u0085b\u009bc')).toBe('abc')
  })
})

describe('planSend', () => {
  test('an agent gets one bracketed paste, so a multi-line prompt is one message', () => {
    const plan = planSend('line one\nline two', [agent('a')], { enter: false })
    expect(plan.items).toEqual([{ id: 'a', name: 'a', how: 'paste', data: `${ESC}[200~line one\nline two${ESC}[201~` }])
  })

  test('nothing presses Enter unless asked; when asked, one Enter follows the paste', () => {
    expect(planSend('hi', [agent('a')], { enter: false }).items[0]?.data?.endsWith('\r')).toBe(false)
    expect(planSend('hi', [agent('a')], { enter: true }).items[0]?.data?.endsWith(`${ESC}[201~\r`)).toBe(true)
  })

  test('a text that tries to end the paste early cannot: the escape is stripped before framing', () => {
    const data = planSend(`ok${ESC}[201~; echo pwned`, [agent('a')], { enter: true }).items[0]?.data ?? ''
    expect(data.split(`${ESC}[201~`)).toHaveLength(2)
    expect(data.indexOf('echo pwned')).toBeLessThan(data.indexOf(`${ESC}[201~`))
  })

  test('a plain shell gets single-line text as it is; a multi-line prompt is refused for it, never sent line by line', () => {
    const one = planSend('git status', [shell('s')], { enter: false }).items[0]
    expect(one).toEqual({ id: 's', name: 's', how: 'line', data: 'git status' })
    const many = planSend('a\nb', [shell('s')], { enter: true }).items[0]
    expect(many).toMatchObject({ id: 's', how: 'refused' })
    expect(many?.data).toBeUndefined()
    expect(many && 'reason' in many ? many.reason : '').toContain('more than one line')
  })

  test('a closed shell is refused; the others still go', () => {
    const plan = planSend('hi', [{ ...agent('a'), running: false }, agent('b')], { enter: false })
    expect(plan.items.map((i) => [i.id, i.how])).toEqual([['a', 'refused'], ['b', 'paste']])
    const first = plan.items[0]
    expect(first && 'reason' in first ? first.reason : '').toContain('closed')
  })

  test('empty after cleaning, or over the limit, is refused for everyone', () => {
    for (const text of ['', '   \n', `${ESC}${ESC}`]) {
      expect(planSend(text, [agent('a'), shell('b')], { enter: false }).items.every((i) => i.how === 'refused')).toBe(true)
    }
    expect(planSend('x'.repeat(100_001), [agent('a')], { enter: false }).items[0]?.how).toBe('refused')
  })

  test('no targets, no items', () => {
    expect(planSend('hi', [], { enter: false }).items).toEqual([])
  })
})
