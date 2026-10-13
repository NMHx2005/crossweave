import { describe, expect, test } from 'bun:test'
import { categoryForHeading, filterReleases, paginateReleases, type ReleaseEntry } from '../src/changelog-controls'

const newest: ReleaseEntry = { tag: 'v0.6.0', categories: ['new', 'fixed'], searchText: 'parallel sessions with isolated worktrees', href: '#v0-6-0' }
const cockpit: ReleaseEntry = { tag: 'v0.5.0', categories: ['new', 'upgrading'], searchText: 'cockpit settings and installation', href: '#v0-5-0' }
const removed: ReleaseEntry = { tag: 'v0.4.0', categories: ['removed', 'known-limits'], searchText: 'legacy remote control and limitations', href: '#v0-4-0' }
const oldest: ReleaseEntry = { tag: 'v0.3.0', categories: ['fixed'], searchText: 'lease reliability', href: '#v0-3-0' }
const entries = [newest, cockpit, removed, oldest]

describe('Changelog filtering and paging', () => {
  test('maps English and Vietnamese headings, including suffixed category titles', () => {
    expect(categoryForHeading('New — parallel sessions')).toBe('new')
    expect(categoryForHeading('Fixed — land and lease reliability')).toBe('fixed')
    expect(categoryForHeading('Đã sửa — độ tin cậy')).toBe('fixed')
    expect(categoryForHeading('Đã loại bỏ')).toBe('removed')
    expect(categoryForHeading('Giới hạn đã biết')).toBe('known-limits')
    expect(categoryForHeading('Điểm nhấn')).toBeNull()
  })

  test('combines text, version and category filters while retaining input order', () => {
    expect(filterReleases(entries, { query: 'COCKPIT setting', version: 'v0.5.0', category: 'new' })).toEqual([cockpit])
    expect(filterReleases(entries, { query: 'remote', version: 'all', category: 'known-limits' })).toEqual([removed])
    expect(filterReleases(entries, { query: 'LEASE', version: 'all', category: 'fixed' })).toEqual([oldest])
    expect(filterReleases(entries, { query: 'missing', version: 'all', category: 'all' })).toEqual([])
  })

  test('paginates three releases, clamps boundaries, and represents an empty result set', () => {
    expect(paginateReleases(entries, 1)).toEqual({ entries: entries.slice(0, 3), page: 1, pageCount: 2, total: 4 })
    expect(paginateReleases(entries, 2)).toEqual({ entries: entries.slice(3), page: 2, pageCount: 2, total: 4 })
    expect(paginateReleases(entries, 99).page).toBe(2)
    expect(paginateReleases(entries, 0).page).toBe(1)
    expect(paginateReleases([], 1)).toEqual({ entries: [], page: 1, pageCount: 1, total: 0 })
  })
})
