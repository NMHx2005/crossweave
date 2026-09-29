import { describe, expect, test } from 'bun:test'
import { appendSnippet, appendText, initialVoiceState, voiceReducer, type VoiceEvent, type VoiceState } from '../src/lib/voice-state'

const run = (events: VoiceEvent[], from: VoiceState = initialVoiceState()): VoiceState => events.reduce(voiceReducer, from)

describe('appendText', () => {
  test('into an empty draft it is the text; otherwise one space joins, never two', () => {
    expect(appendText('', 'hello')).toBe('hello')
    expect(appendText('hello', 'world')).toBe('hello world')
    expect(appendText('hello ', 'world')).toBe('hello world')
    expect(appendText('hello\n', 'world')).toBe('hello\nworld')
  })
})

describe('appendSnippet', () => {
  test('goes on its own line at the end, and an empty draft is just the snippet', () => {
    expect(appendSnippet('', 'Investigate first.')).toBe('Investigate first.')
    expect(appendSnippet('fix the bug', 'Investigate first.')).toBe('fix the bug\n\nInvestigate first.')
    expect(appendSnippet('fix the bug\n', 'Investigate first.')).toBe('fix the bug\n\nInvestigate first.')
    expect(appendSnippet('fix the bug\n\n', 'Investigate first.')).toBe('fix the bug\n\nInvestigate first.')
  })
})

describe('recording', () => {
  test('toggle starts recording, and a second toggle stops it and starts transcribing', () => {
    const s1 = run([{ type: 'toggle' }])
    expect(s1.phase).toBe('recording')
    expect(run([{ type: 'toggle' }], s1).phase).toBe('transcribing')
  })

  test('the transcript is appended to the draft and the state returns to idle', () => {
    const s = run([{ type: 'edit', text: 'first' }, { type: 'toggle' }, { type: 'toggle' }, { type: 'transcribed', text: 'second' }])
    expect(s).toMatchObject({ phase: 'idle', draft: 'first second', error: null })
  })

  test('toggle while transcribing or refining does nothing: one job at a time', () => {
    const t = run([{ type: 'toggle' }, { type: 'toggle' }])
    expect(run([{ type: 'toggle' }], t)).toEqual(t)
  })

  test('a failure returns to idle with the draft intact and the reason kept', () => {
    const s = run([{ type: 'edit', text: 'keep me' }, { type: 'toggle' }, { type: 'toggle' }, { type: 'failed', reason: 'model not found' }])
    expect(s).toMatchObject({ phase: 'idle', draft: 'keep me', error: 'model not found' })
  })

  test('a failure while still recording (the mic went away) also returns to idle', () => {
    const s = run([{ type: 'toggle' }, { type: 'failed', reason: 'Microphone unavailable' }])
    expect(s).toMatchObject({ phase: 'idle', error: 'Microphone unavailable' })
  })

  test('starting a new recording clears the previous error', () => {
    const failed = run([{ type: 'toggle' }, { type: 'failed', reason: 'x' }])
    expect(run([{ type: 'toggle' }], failed).error).toBeNull()
  })

  test('cancelling a recording discards it without transcribing', () => {
    const s = run([{ type: 'edit', text: 'keep' }, { type: 'toggle' }, { type: 'cancel' }])
    expect(s).toMatchObject({ phase: 'idle', draft: 'keep' })
  })
})

describe('editing', () => {
  test('edit replaces the draft; clear empties it and any pending proposal', () => {
    expect(run([{ type: 'edit', text: 'abc' }]).draft).toBe('abc')
    const s = run([{ type: 'setRefine', enabled: true }, { type: 'edit', text: 'abc' }, { type: 'refine' }, { type: 'refined', text: 'ABC' }, { type: 'clear' }])
    expect(s).toMatchObject({ draft: '', proposal: null })
  })

  test('sent clears the draft', () => {
    expect(run([{ type: 'edit', text: 'abc' }, { type: 'sent' }]).draft).toBe('')
  })
})

describe('refinement', () => {
  const ready = (): VoiceState => run([{ type: 'setRefine', enabled: true }, { type: 'edit', text: 'raw words' }])

  test('is unavailable while its switch is off: refine does nothing', () => {
    const s = run([{ type: 'edit', text: 'raw words' }, { type: 'refine' }])
    expect(s.phase).toBe('idle')
  })

  test('refine with an empty draft does nothing', () => {
    expect(run([{ type: 'setRefine', enabled: true }, { type: 'refine' }]).phase).toBe('idle')
  })

  test('the proposal sits beside the draft: the draft is untouched until Accept', () => {
    const s = run([{ type: 'refine' }, { type: 'refined', text: '# Objective\nraw words' }], ready())
    expect(s).toMatchObject({ phase: 'idle', draft: 'raw words', proposal: '# Objective\nraw words' })
  })

  test('Accept replaces the draft with the proposal; Revert drops the proposal', () => {
    const proposed = run([{ type: 'refine' }, { type: 'refined', text: 'REFINED' }], ready())
    expect(run([{ type: 'accept' }], proposed)).toMatchObject({ draft: 'REFINED', proposal: null })
    expect(run([{ type: 'revert' }], proposed)).toMatchObject({ draft: 'raw words', proposal: null })
  })

  test('a failed refinement keeps the draft and says why', () => {
    const s = run([{ type: 'refine' }, { type: 'failed', reason: 'claude: not logged in' }], ready())
    expect(s).toMatchObject({ phase: 'idle', draft: 'raw words', proposal: null, error: 'claude: not logged in' })
  })

  test('editing the draft while a proposal is pending withdraws the proposal: it no longer matches', () => {
    const proposed = run([{ type: 'refine' }, { type: 'refined', text: 'REFINED' }], ready())
    expect(run([{ type: 'edit', text: 'raw words!' }], proposed).proposal).toBeNull()
  })

  test('switching refinement off withdraws a pending proposal', () => {
    const proposed = run([{ type: 'refine' }, { type: 'refined', text: 'REFINED' }], ready())
    expect(run([{ type: 'setRefine', enabled: false }], proposed).proposal).toBeNull()
  })

  test('a transcript arriving with a proposal pending withdraws it too', () => {
    const proposed = run([{ type: 'refine' }, { type: 'refined', text: 'REFINED' }], ready())
    const s = run([{ type: 'toggle' }, { type: 'toggle' }, { type: 'transcribed', text: 'more' }], proposed)
    expect(s.proposal).toBeNull()
    expect(s.draft).toBe('raw words more')
  })
})
