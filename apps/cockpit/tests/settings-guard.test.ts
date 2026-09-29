import { describe, expect, test } from 'bun:test'
import { restoreGuarded, withGuardedFromFile } from '../electron/settings-guard'

const persistence = { terminals: true }

describe('withGuardedFromFile', () => {
  // A daemon older than the app has never heard of `persistence`: it neither returns it nor keeps it,
  // so the page would show an empty section while the file still holds the user's setup.
  test("adds the file's block when the daemon's answer has none", () => {
    expect(withGuardedFromFile({ editor: { kind: 'zed' }, launchers: [] }, { persistence })).toEqual({ editor: { kind: 'zed' }, launchers: [], persistence })
  })

  test("leaves a daemon's own block alone (a current daemon is authoritative)", () => {
    const own = { terminals: false }
    expect(withGuardedFromFile({ persistence: own }, { persistence })).toEqual({ persistence: own })
  })

  test('nothing in the file: the answer is the same object', () => {
    const answer = { editor: { kind: 'zed' } }
    expect(withGuardedFromFile(answer, {})).toBe(answer)
  })

  test('an answer that is not an object passes through untouched', () => {
    expect(withGuardedFromFile(null, { persistence })).toBeNull()
    expect(withGuardedFromFile('x', { persistence })).toBe('x')
  })
})

describe('restoreGuarded', () => {
  test('a save that carried a block which the file no longer has: it must be written back', () => {
    expect(restoreGuarded({ settings: { persistence } }, {})).toEqual({ persistence })
  })

  test('only what was lost: a block the file kept is not restored', () => {
    expect(restoreGuarded({ settings: { persistence } }, { persistence })).toEqual({})
  })

  test('the save carried no block (the user cleared it): never resurrect it', () => {
    expect(restoreGuarded({ settings: { editor: { kind: 'zed' } } }, {})).toEqual({})
  })

  test('an empty block is not worth restoring', () => {
    expect(restoreGuarded({ settings: { persistence: {} } }, {})).toEqual({})
  })

  test('a malformed request restores nothing', () => {
    expect(restoreGuarded(null, {})).toEqual({})
    expect(restoreGuarded({ settings: 'x' }, {})).toEqual({})
    expect(restoreGuarded({}, {})).toEqual({})
  })
})
