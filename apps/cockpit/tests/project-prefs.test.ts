import { describe, expect, test } from 'bun:test'
import { moveProject, parsePrefs, projectLabel, withPrefs } from '../src/lib/project-prefs'

describe('parsePrefs', () => {
  test('keeps what is valid, drops the rest', () => {
    expect(parsePrefs({
      '/w/api': { label: '  API   server ', color: 'ready', launcher: 'claude', worktree: true, base: 'main', hideEnded: true, extra: 1 },
      '/w/web': { color: 'pink', launcher: 'rm -rf', worktree: 'yes', label: '   ' },
    })).toEqual({ '/w/api': { label: 'API server', color: 'ready', launcher: 'claude', worktree: true, base: 'main', hideEnded: true } })
    expect(parsePrefs(null)).toEqual({})
    expect(parsePrefs([1])).toEqual({})
    expect(parsePrefs('x')).toEqual({})
  })

  test('a label is capped', () => {
    expect(parsePrefs({ '/w': { label: 'x'.repeat(200) } })['/w']?.label).toHaveLength(60)
  })
})

describe('withPrefs', () => {
  test('patches, clears with undefined, and drops an empty entry', () => {
    const one = withPrefs({}, '/w/api', { label: 'API' })
    expect(one).toEqual({ '/w/api': { label: 'API' } })
    const two = withPrefs(one, '/w/api', { worktree: false })
    expect(two['/w/api']).toEqual({ label: 'API', worktree: false })
    expect(withPrefs(two, '/w/api', { label: undefined, worktree: undefined })).toEqual({})
    // An empty label resets to the folder name.
    expect(withPrefs(one, '/w/api', { label: '' })).toEqual({})
  })
})

describe('projectLabel', () => {
  test('the chosen name, else the fallback', () => {
    expect(projectLabel({ label: 'API' }, 'api')).toBe('API')
    expect(projectLabel(undefined, 'api')).toBe('api')
  })
})

describe('moveProject', () => {
  test('moves within bounds; an unknown root changes nothing', () => {
    expect(moveProject(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b'])
    expect(moveProject(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(moveProject(['a', 'b', 'c'], 'a', 5)).toEqual(['b', 'c', 'a'])
    expect(moveProject(['a', 'b'], 'x', 1)).toEqual(['a', 'b'])
    expect(moveProject([], 'x', 1)).toEqual([])
  })
})
