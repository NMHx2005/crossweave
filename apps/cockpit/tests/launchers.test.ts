import { describe, expect, test } from 'bun:test'
import { formatEnvLines, launcherIdFor, parseEnvLines } from '../src/lib/launchers'

describe('parseEnvLines', () => {
  test('NAME=value per line, blanks and comments skipped, values may hold =', () => {
    expect(parseEnvLines('ANTHROPIC_MODEL=opus\n\n# mine\nURL=http://x?a=b')).toEqual({
      ok: true, env: { ANTHROPIC_MODEL: 'opus', URL: 'http://x?a=b' },
    })
    expect(formatEnvLines({ A: '1', B: '2' })).toBe('A=1\nB=2')
  })

  test('says which line is not NAME=value', () => {
    expect(parseEnvLines('A=1\njust words')).toEqual({ ok: false, error: 'Line 2: write it as NAME=value' })
    expect(parseEnvLines('1BAD=x').ok).toBe(false)
  })
})

describe('launcherIdFor', () => {
  test('a slug of the label, unique, never "terminal"', () => {
    expect(launcherIdFor('cx (my Claude)', [])).toBe('cx-my-claude')
    expect(launcherIdFor('Claude', ['claude'])).toBe('claude-2')
    expect(launcherIdFor('Terminal', [])).toBe('x-terminal')
    expect(launcherIdFor('!!!', [])).toBe('launcher')
  })
})
