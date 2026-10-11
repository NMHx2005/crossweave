import { describe, expect, test } from 'bun:test'
import { authorizeLiveLand } from '../src/lib/live-land'

describe('authorizeLiveLand', () => {
  test('dirty work needs a commit before any stop confirmation', async () => {
    let prompted = false
    const result = await authorizeLiveLand({ uncommitted: 2, running: true, confirm: async () => { prompted = true; return true } })
    expect(result).toBe('needs_commit')
    expect(prompted).toBe(false)
  })

  test('unknown worktree status blocks the stop confirmation', async () => {
    let prompted = false
    const result = await authorizeLiveLand({ uncommitted: null, running: true, confirm: async () => { prompted = true; return true } })
    expect(result).toBe('status_unknown')
    expect(prompted).toBe(false)
  })

  test('a clean live session can be cancelled without authorization', async () => {
    const result = await authorizeLiveLand({ uncommitted: 0, running: true, confirm: async () => false })
    expect(result).toBe('cancelled')
  })

  test('an idle clean session does not receive the stop prompt', async () => {
    let prompted = false
    const result = await authorizeLiveLand({ uncommitted: 0, running: false, confirm: async () => { prompted = true; return true } })
    expect(result).toBe('idle')
    expect(prompted).toBe(false)
  })

  test('a clean live session is authorized only after confirmation', async () => {
    const result = await authorizeLiveLand({ uncommitted: 0, running: true, confirm: async () => true })
    expect(result).toBe('confirmed')
  })
})
