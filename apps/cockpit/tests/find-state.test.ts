import { describe, expect, test } from 'bun:test'
import { CLOSED_FIND, findLabel, findReducer } from '../src/lib/find-state'

describe('findReducer', () => {
  test('open, type, get results, close; reopening keeps the term and options', () => {
    let s = findReducer(CLOSED_FIND, { type: 'open' })
    s = findReducer(s, { type: 'term', term: 'error' })
    s = findReducer(s, { type: 'toggle', option: 'caseSensitive' })
    s = findReducer(s, { type: 'results', resultIndex: 2, resultCount: 7 })
    expect(s).toMatchObject({ open: true, term: 'error', caseSensitive: true, resultIndex: 2, resultCount: 7 })
    s = findReducer(s, { type: 'close' })
    expect(s).toMatchObject({ open: false, term: 'error', caseSensitive: true, resultCount: 0 })
    expect(findReducer(s, { type: 'open' })).toMatchObject({ open: true, term: 'error', caseSensitive: true })
  })

  test('a new term or option forgets the old counts', () => {
    const counted = { ...CLOSED_FIND, open: true, term: 'a', resultIndex: 0, resultCount: 3 }
    expect(findReducer(counted, { type: 'term', term: 'ab' })).toMatchObject({ resultIndex: -1, resultCount: 0 })
    expect(findReducer(counted, { type: 'toggle', option: 'regex' })).toMatchObject({ regex: true, resultIndex: -1, resultCount: 0 })
  })
})

describe('findLabel', () => {
  test('nothing typed, no results, a count, a position', () => {
    expect(findLabel(CLOSED_FIND)).toBe('')
    expect(findLabel({ ...CLOSED_FIND, term: 'x' })).toBe('No results')
    expect(findLabel({ ...CLOSED_FIND, term: 'x', resultCount: 4 })).toBe('4 found')
    expect(findLabel({ ...CLOSED_FIND, term: 'x', resultIndex: 0, resultCount: 4 })).toBe('1 of 4')
  })
})
