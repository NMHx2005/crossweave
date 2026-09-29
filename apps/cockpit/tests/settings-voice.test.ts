import { describe, expect, test } from 'bun:test'
import { restoreGuarded, withGuardedFromFile } from '../electron/settings-voice'

const voice = { transcribeCommand: 'whisper-cli -f {audio}', language: 'vi' as const }
const persistence = { terminals: true }

describe('withGuardedFromFile', () => {
  // A daemon older than the app has never heard of `voice` or `persistence`: it neither returns them nor
  // keeps them, so the page would show an empty section while the file still holds the user's setup.
  test("adds the file's blocks when the daemon's answer has none", () => {
    expect(withGuardedFromFile({ editor: { kind: 'zed' }, launchers: [] }, { voice, persistence })).toEqual({ editor: { kind: 'zed' }, launchers: [], voice, persistence })
  })

  test("leaves a daemon's own block alone (a current daemon is authoritative), and fills only the missing one", () => {
    const own = { transcribeCommand: 'other' }
    expect(withGuardedFromFile({ voice: own }, { voice, persistence })).toEqual({ voice: own, persistence })
  })

  test('nothing in the file: the answer is the same object', () => {
    const answer = { editor: { kind: 'zed' } }
    expect(withGuardedFromFile(answer, {})).toBe(answer)
  })

  test('an answer that is not an object passes through untouched', () => {
    expect(withGuardedFromFile(null, { voice })).toBeNull()
    expect(withGuardedFromFile('x', { voice })).toBe('x')
  })
})

describe('restoreGuarded', () => {
  test('a save that carried a block which the file no longer has: it must be written back', () => {
    expect(restoreGuarded({ settings: { voice, persistence } }, {})).toEqual({ voice, persistence })
  })

  test('only what was lost: a block the file kept is not restored', () => {
    expect(restoreGuarded({ settings: { voice, persistence } }, { voice })).toEqual({ persistence })
  })

  test('the save carried no block (the user cleared it): never resurrect it', () => {
    expect(restoreGuarded({ settings: { editor: { kind: 'zed' } } }, {})).toEqual({})
  })

  test('an empty block is not worth restoring', () => {
    expect(restoreGuarded({ settings: { voice: {} } }, {})).toEqual({})
  })

  test('a malformed request restores nothing', () => {
    expect(restoreGuarded(null, {})).toEqual({})
    expect(restoreGuarded({ settings: 'x' }, {})).toEqual({})
    expect(restoreGuarded({}, {})).toEqual({})
  })
})
