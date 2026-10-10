import { describe, expect, test } from 'bun:test'
import { canSendFailure, formatCheckFailure } from '../src/lib/check-failure'

const fail = (over: Partial<Parameters<typeof formatCheckFailure>[0]> = {}): string => formatCheckFailure({ stale: false, ...over })
const ESC = '\x1b'

describe('formatCheckFailure', () => {
  test('says what failed, with the exit code and duration when known, then the end of the output', () => {
    expect(fail({ code: 1, ms: 12345, tail: '1 test failed\n' })).toBe("The project's tests failed (exit 1, 12.3s). End of the output:\n\n1 test failed")
    expect(fail({ tail: 'boom' })).toBe("The project's tests failed. End of the output:\n\nboom")
    expect(fail({ code: 2, tail: 'boom' })).toContain('(exit 2)')
    expect(fail({ ms: 1500, tail: 'boom' })).toContain('(1.5s)')
  })

  test('warns when the work has changed since the run', () => {
    expect(fail({ code: 1, tail: 'x', stale: true })).toContain('(exit 1), possibly out of date. End of the output:')
    expect(fail({ code: 1, tail: 'x' })).not.toContain('out of date')
  })

  test('an empty or blank tail, or one that was only colour codes, says so', () => {
    for (const tail of [undefined, '', '  \n\n', `${ESC}[31m${ESC}[0m`]) expect(fail({ tail })).toEndWith('(no output was captured)')
  })

  test('colour, cursor and title sequences are gone', () => {
    const tail = `${ESC}[31;1mFAIL${ESC}[0m src/a.test.ts\n${ESC}]0;title\x07${ESC}[2K${ESC}[1Aok`
    expect(fail({ tail })).toEndWith('FAIL src/a.test.ts\nok')
  })

  test('colon-separated and private-parameter sequences are gone too', () => {
    expect(fail({ tail: `${ESC}[38:2::255:0:0mRED${ESC}[>4;1mX${ESC}[<u` })).toEndWith('REDX')
  })

  test('a string sequence (DCS) and an OSC that never ends leave no text behind', () => {
    expect(fail({ tail: `a${ESC}Pq#0;2;0;0;0${ESC}\\b` })).toEndWith('ab')
    expect(fail({ tail: `visible${ESC}]0;hidden title with no terminator` })).toEndWith('visible')
  })

  test('a progress bar keeps its last frame, CRLF lines are plain lines', () => {
    expect(fail({ tail: '10%\r50%\r100%\ndone\r\nbye\r\n' })).toEndWith('100%\ndone\nbye')
  })

  test('characters that hide or move text are removed (a tag-block message is invisible to the person)', () => {
    const hidden = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e)
    const out = fail({ tail: `ok${hidden}‮reversed​﻿` })
    expect(out).toEndWith('okreversed')
    expect(out).not.toMatch(/[\u{E0000}-\u{E007F}‮​﻿]/u)
  })

  test('a token printed by a test is redacted before it goes to an agent', () => {
    const tail = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nfailed'
    const out = fail({ tail })
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(out).not.toContain('wJalrXUtnFEMI')
    expect(out).toContain('failed')
  })

  test('a long output is cut from the end, at a line start when it can be', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(3, '0')} of the output`)
    const out = fail({ tail: lines.join('\n') })
    const body = out.slice(out.indexOf('\n\n') + 2)
    expect(body.length).toBeLessThanOrEqual(2000)
    expect(body.endsWith('line 399 of the output')).toBe(true)
    expect(body.startsWith('line ')).toBe(true)
    expect(fail({ tail: 'x'.repeat(100_000) }).length).toBeLessThan(2300)
  })
})

describe('canSendFailure', () => {
  test('only a failed verdict has something to send', () => {
    expect(canSendFailure({ check: { state: 'fail' } })).toBe(true)
    for (const state of ['pass', 'running']) expect(canSendFailure({ check: { state } })).toBe(false)
    expect(canSendFailure({})).toBe(false)
  })
})
