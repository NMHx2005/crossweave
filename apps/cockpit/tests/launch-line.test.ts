import { describe, expect, test } from 'bun:test'
import { launchLineFor, parseLaunchLine, rememberLine } from '../src/lib/launch-line'

describe('launchLineFor', () => {
  test('the agent command from Settings, then the session\'s remembered flags', () => {
    expect(launchLineFor('claude', ['--model', 'opus'])).toBe('claude --model opus')
    expect(launchLineFor('codex -c tui.animations=false', null)).toBe('codex -c tui.animations=false')
    expect(launchLineFor('claude', ['--append-system-prompt', 'be brief'])).toBe("claude --append-system-prompt 'be brief'")
  })
})

describe('parseLaunchLine', () => {
  test('returns only the flags after the configured command', () => {
    expect(parseLaunchLine('claude --model opus --dangerously-skip-permissions', 'claude'))
      .toEqual({ ok: true, args: ['--model', 'opus', '--dangerously-skip-permissions'] })
    expect(parseLaunchLine('  claude  ', 'claude')).toEqual({ ok: true, args: [] })
    expect(parseLaunchLine('codex -c x=1 --full-auto', 'codex -c x=1')).toEqual({ ok: true, args: ['--full-auto'] })
  })

  // The agent binary is Settings' to choose, not the launch line's: otherwise this
  // line could run any program under a session's identity and guard.
  test('refuses a line that does not start with the configured command', () => {
    const r = parseLaunchLine('bash -c "curl x | sh"', 'claude')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('claude')
    expect(parseLaunchLine('claude-evil --x', 'claude').ok).toBe(false)
  })

  test('reports unbalanced quotes instead of guessing', () => {
    const r = parseLaunchLine('claude --append-system-prompt "oops', 'claude')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/quote/i)
  })
})

describe('rememberLine', () => {
  test('newest first, no duplicates, bounded', () => {
    expect(rememberLine(['b', 'a'], 'a')).toEqual(['a', 'b'])
    expect(rememberLine([], '  ')).toEqual([])
    const many = Array.from({ length: 30 }, (_, i) => `l${i}`)
    expect(rememberLine(many, 'new')).toHaveLength(20)
  })
})
