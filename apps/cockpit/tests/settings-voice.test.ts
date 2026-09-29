import { describe, expect, test } from 'bun:test'
import { restoreVoice, withVoiceFromFile } from '../electron/settings-voice'

const voice = { transcribeCommand: 'whisper-cli -f {audio}', language: 'vi' as const }

describe('withVoiceFromFile', () => {
  // A daemon older than the app has never heard of `voice`: it neither returns it nor keeps
  // it, so the page would show an empty section while the file still holds the user's setup.
  test("adds the file's voice when the daemon's answer has none", () => {
    expect(withVoiceFromFile({ editor: { kind: 'zed' }, launchers: [] }, voice)).toEqual({ editor: { kind: 'zed' }, launchers: [], voice })
  })

  test("leaves a daemon's own voice alone (a current daemon is authoritative)", () => {
    const own = { transcribeCommand: 'other' }
    expect(withVoiceFromFile({ voice: own }, voice)).toEqual({ voice: own })
  })

  test('nothing in the file: the answer is unchanged', () => {
    const answer = { editor: { kind: 'zed' } }
    expect(withVoiceFromFile(answer, undefined)).toBe(answer)
  })

  test('an answer that is not an object passes through untouched', () => {
    expect(withVoiceFromFile(null, voice)).toBeNull()
    expect(withVoiceFromFile('x', voice)).toBe('x')
  })
})

describe('restoreVoice', () => {
  test('a save that carried voice which the file no longer has: it must be written back', () => {
    expect(restoreVoice({ settings: { voice } }, { voice: undefined })).toEqual(voice)
  })

  test('the file kept it: nothing to restore', () => {
    expect(restoreVoice({ settings: { voice } }, { voice })).toBeUndefined()
  })

  test('the save carried no voice (the user cleared it): never resurrect it', () => {
    expect(restoreVoice({ settings: { editor: { kind: 'zed' } } }, { voice: undefined })).toBeUndefined()
  })

  test('an empty voice block is not worth restoring', () => {
    expect(restoreVoice({ settings: { voice: {} } }, { voice: undefined })).toBeUndefined()
  })

  test('a malformed request restores nothing', () => {
    expect(restoreVoice(null, { voice: undefined })).toBeUndefined()
    expect(restoreVoice({ settings: 'x' }, { voice: undefined })).toBeUndefined()
    expect(restoreVoice({}, { voice: undefined })).toBeUndefined()
  })
})
