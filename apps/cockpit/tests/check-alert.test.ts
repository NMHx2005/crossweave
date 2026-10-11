import { describe, expect, test } from 'bun:test'
import { checkAlertBody, checkAlertTitle, createCheckAlerts } from '../src/lib/check-alert'
import type { ListedSession } from '../src/lib/sessions'

type Check = NonNullable<ListedSession['check']>
const withCheck = (id: string, check: Check): ListedSession => ({ id, name: id, check }) as ListedSession
const failed = (id: string, over: Partial<Check> = {}): ListedSession => withCheck(id, { state: 'fail', at: 1, stale: false, ...over })
const withoutCheck = (id: string): ListedSession => ({ id, name: id }) as ListedSession
const ids = (list: ListedSession[]): string[] => list.map((x) => x.id)

describe('createCheckAlerts', () => {
  test('a pass, a run still going, a stale failure and a session without a verdict announce nothing', () => {
    const a = createCheckAlerts()
    expect(a.take([
      withCheck('a', { state: 'pass', at: 1, stale: false }),
      withCheck('b', { state: 'running', at: 1, stale: false }),
      failed('c', { stale: true }),
      withoutCheck('d'),
    ])).toEqual([])
  })

  test('a failure is announced once, however often the list repeats it', () => {
    const a = createCheckAlerts()
    expect(ids(a.take([failed('a')]))).toEqual(['a'])
    expect(a.take([failed('a')])).toEqual([])
    expect(a.take([failed('a')])).toEqual([])
  })

  test('a new run that fails again is announced again', () => {
    const a = createCheckAlerts()
    a.take([failed('a', { at: 1 })])
    expect(ids(a.take([failed('a', { at: 2 })]))).toEqual(['a'])
  })

  test('runs arriving out of order never announce a run already told: 1, 2, 1, 2', () => {
    const a = createCheckAlerts()
    expect(ids(a.take([failed('a', { at: 1 })]))).toEqual(['a'])
    expect(ids(a.take([failed('a', { at: 2 })]))).toEqual(['a'])
    expect(a.take([failed('a', { at: 1 })])).toEqual([])
    expect(a.take([failed('a', { at: 2 })])).toEqual([])
  })

  test('a verdict that disappears and returns with the same run is not announced again', () => {
    const a = createCheckAlerts()
    a.take([failed('a')])
    a.take([withoutCheck('a')])
    expect(a.take([failed('a')])).toEqual([])
  })

  test('what the first snapshot already held is told to nobody; what comes after is', () => {
    const a = createCheckAlerts()
    a.seed([failed('a')])
    expect(ids(a.take([failed('a'), failed('b')]))).toEqual(['b'])
  })

  test('a failure that is stale when first seen is never announced, and a pass between runs forgets nothing', () => {
    const a = createCheckAlerts()
    expect(a.take([failed('a', { stale: true })])).toEqual([])
    a.take([failed('a', { at: 1 })])
    a.take([withCheck('a', { state: 'pass', at: 2, stale: false })])
    expect(a.take([failed('a', { at: 1 })])).toEqual([])
  })

  test('sessions are told apart: one session\'s run does not hide another\'s', () => {
    const a = createCheckAlerts()
    a.take([failed('a', { at: 5 })])
    expect(ids(a.take([failed('b', { at: 5 })]))).toEqual(['b'])
  })
})

describe('the words of the alert', () => {
  test('title and body never carry output, and a hostile name is cleaned', () => {
    expect(checkAlertTitle('api\n‮secret')).toBe('api secret: tests failed')
    expect(checkAlertBody({ code: 1, ms: 12300 })).toBe('exit 1, 12.3s')
    expect(checkAlertBody({ code: 2 })).toBe('exit 2')
    expect(checkAlertBody({ ms: 900 })).toBe('0.9s')
    expect(checkAlertBody({})).toBe("The project's tests failed")
  })

  test('a very long name is cut', () => {
    expect(checkAlertTitle('n'.repeat(200)).length).toBeLessThanOrEqual(60 + ': tests failed'.length)
  })
})
