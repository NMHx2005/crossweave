import { describe, expect, test } from 'bun:test'
import { describePreset, planPreset, presetUrl } from '../src/lib/presets'

describe('planPreset', () => {
  test('defaults: a plain terminal, an own worktree, no extras', () => {
    expect(planPreset({ name: 'scratch' })).toEqual({ launcher: 'terminal', worktree: true, terminals: [], browserPath: undefined })
  })

  test('carries the launcher, the worktree choice, the terminal commands in order and the browser path', () => {
    expect(planPreset({ name: 'web', launcher: 'claude', worktree: false, terminals: ['bun dev', 'bun test'], browser: { path: '/admin' } }))
      .toEqual({ launcher: 'claude', worktree: false, terminals: ['bun dev', 'bun test'], browserPath: '/admin' })
  })

  test('a browser with no path is the root', () => {
    expect(planPreset({ name: 'web', browser: {} }).browserPath).toBe('/')
  })
})

describe('presetUrl', () => {
  test("the session's leased port on localhost, at the path", () => {
    expect(presetUrl(43010, '/admin')).toBe('http://localhost:43010/admin')
    expect(presetUrl(43010, '/')).toBe('http://localhost:43010/')
  })

  test('no leased port means no address: the caller says so instead of guessing one', () => {
    expect(presetUrl(undefined, '/')).toBeUndefined()
    expect(presetUrl(0, '/')).toBeUndefined()
    expect(presetUrl(70000, '/')).toBeUndefined()
  })
})

describe('describePreset', () => {
  test('says what one click will do, so nothing is a surprise', () => {
    expect(describePreset({ name: 'web', launcher: 'claude', terminals: ['bun dev', 'bun test'], browser: {} }, (id) => (id === 'claude' ? 'Claude Code' : id)))
      .toBe('Claude Code · own worktree · runs bun dev, bun test · browser on its port')
    expect(describePreset({ name: 'x', worktree: false }, (id) => id)).toBe('terminal · project folder')
  })
})
