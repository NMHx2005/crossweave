import { describe, expect, test } from 'bun:test'
import { compareSessions, defaultCompareTarget } from '../src/lib/compare'
import type { SessionDiff } from '../src/lib/patch'

const patchFor = (path: string, body: string[]): string => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', ...body].join('\n')
const diff = (files: SessionDiff['files'], patch = ''): SessionDiff => ({ files, patch, truncated: false, uncommitted: 0 })
const file = (path: string, added = 1, deleted = 0, status: 'added' | 'modified' | 'deleted' = 'modified') => ({ path, status, added, deleted })

describe('compareSessions', () => {
  test('the files both touched are marked and come first; the rest keep path order', () => {
    const c = compareSessions(
      { name: 'a', diff: diff([file('z.ts'), file('shared.ts'), file('a.ts')]) },
      { name: 'b', diff: diff([file('shared.ts'), file('m.ts')]) },
    )
    expect(c.shared).toEqual(['shared.ts'])
    expect(c.a.files.map((f) => [f.path, f.both])).toEqual([['shared.ts', true], ['a.ts', false], ['z.ts', false]])
    expect(c.b.files.map((f) => [f.path, f.both])).toEqual([['shared.ts', true], ['m.ts', false]])
  })

  test('totals per side: files, lines added and deleted', () => {
    const c = compareSessions(
      { name: 'a', diff: diff([file('x', 5, 2), file('y', 1, 0)]) },
      { name: 'b', diff: diff([]) },
    )
    expect(c.a.totals).toEqual({ files: 2, added: 6, deleted: 2 })
    expect(c.b.totals).toEqual({ files: 0, added: 0, deleted: 0 })
    expect(c.shared).toEqual([])
  })

  test('the same file changed the same way on both sides says so; a different change does not', () => {
    const same = compareSessions(
      { name: 'a', diff: diff([file('f.ts')], patchFor('f.ts', ['-old', '+new'])) },
      { name: 'b', diff: diff([file('f.ts')], patchFor('f.ts', ['-old', '+new'])) },
    )
    expect(same.a.files[0]?.same).toBe(true)
    const differ = compareSessions(
      { name: 'a', diff: diff([file('f.ts')], patchFor('f.ts', ['-old', '+new'])) },
      { name: 'b', diff: diff([file('f.ts')], patchFor('f.ts', ['-old', '+other'])) },
    )
    expect(differ.a.files[0]?.same).toBe(false)
    expect(differ.b.files[0]?.same).toBe(false)
  })

  test('a cut-off patch cannot prove two changes are the same: not "same" when either side was truncated', () => {
    const truncated = { ...diff([file('f.ts')], patchFor('f.ts', ['+x'])), truncated: true }
    const c = compareSessions({ name: 'a', diff: truncated }, { name: 'b', diff: diff([file('f.ts')], patchFor('f.ts', ['+x'])) })
    expect(c.a.files[0]?.same).toBe(false)
    expect(c.a.truncated).toBe(true)
  })

  test('uncommitted work is reported per side: landing does not take it', () => {
    const c = compareSessions({ name: 'a', diff: { ...diff([]), uncommitted: 3 } }, { name: 'b', diff: diff([]) })
    expect(c.a.uncommitted).toBe(3)
    expect(c.b.uncommitted).toBe(0)
  })
})

describe('defaultCompareTarget', () => {
  const s = (id: string, overlaps?: Array<{ session: string; paths: string[] }>) => ({ id, name: id, ...(overlaps ? { overlaps } : {}) })

  test('the session overlapping most with this one; else the first other; else nothing', () => {
    const list = [s('a', [{ session: 'c', paths: ['1'] }, { session: 'b', paths: ['1', '2', '3'] }]), s('b'), s('c'), s('d')]
    expect(defaultCompareTarget(list[0]!, list)).toBe('b')
    expect(defaultCompareTarget(s('x'), [s('x'), s('y'), s('z')])).toBe('y')
    expect(defaultCompareTarget(s('x'), [s('x')])).toBeUndefined()
  })

  test('never itself, and an overlap that names a session no longer listed is skipped', () => {
    const list = [s('a', [{ session: 'gone', paths: ['1'] }]), s('b')]
    expect(defaultCompareTarget(list[0]!, list)).toBe('b')
  })
})
