import { describe, expect, test } from 'bun:test'
import { mountedViews, touchRecent } from '../src/lib/mounted-views'

describe('mountedViews', () => {
  const open = ['/a', '/b', '/c', '/d']

  test('the most recent up to the cap, the active one always among them', () => {
    expect(mountedViews(['/b', '/a', '/c'], '/b', open, 2)).toEqual(['/b', '/a'])
    // Active but not yet in the recent list (just opened).
    expect(mountedViews(['/b', '/a', '/c'], '/d', open, 2)).toEqual(['/d', '/b'])
  })

  test('closed projects drop out; duplicates count once', () => {
    expect(mountedViews(['/x', '/a', '/a', '/b'], '/a', open, 6)).toEqual(['/a', '/b'])
  })

  test('no active project (the welcome) and edge caps', () => {
    expect(mountedViews(['/a', '/b'], null, open, 6)).toEqual(['/a', '/b'])
    expect(mountedViews([], null, open, 6)).toEqual([])
    // A cap below one still keeps the project on the stage.
    expect(mountedViews(['/a', '/b'], '/b', open, 0)).toEqual(['/b'])
  })
})

describe('touchRecent', () => {
  test('moves to the front without duplicating', () => {
    expect(touchRecent(['/a', '/b', '/c'], '/c')).toEqual(['/c', '/a', '/b'])
    expect(touchRecent([], '/a')).toEqual(['/a'])
  })
})
