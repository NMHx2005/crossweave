import { describe, expect, test } from 'bun:test'
import { SETTINGS_SECTIONS, findSection, foldText, searchSettings } from '../src/lib/settings-sections'

describe('registry', () => {
  test('every row id is unique across the whole page', () => {
    const ids = SETTINGS_SECTIONS.flatMap((s) => s.rows.map((r) => r.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every section has an id, a title and at least one row', () => {
    expect(SETTINGS_SECTIONS.length).toBeGreaterThan(5)
    for (const s of SETTINGS_SECTIONS) {
      expect(s.id).not.toBe('')
      expect(s.title).not.toBe('')
      expect(s.rows.length).toBeGreaterThan(0)
    }
  })

  test('findSection returns the section, or undefined for an unknown id', () => {
    expect(findSection('terminal')?.title).toBe('Terminal')
    expect(findSection('nope')).toBeUndefined()
  })
})

describe('foldText', () => {
  test('lower-cases and strips diacritics, so Vietnamese can be typed without them', () => {
    expect(foldText('Phím TẮT')).toBe('phim tat')
    expect(foldText('Đường dẫn')).toBe('duong dan')
  })
})

describe('searchSettings', () => {
  test('an empty or blank query matches nothing (the page then shows the chosen section)', () => {
    expect(searchSettings('')).toEqual([])
    expect(searchSettings('   ')).toEqual([])
  })

  test('finds a row by its label, grouped under its section', () => {
    const hits = searchSettings('cursor')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((g) => g.section.rows.length > 0)).toBe(true)
    expect(hits.flatMap((g) => g.rows.map((r) => r.id))).toContain('terminal-cursor')
    expect(hits.find((g) => g.section.id === 'terminal')).toBeDefined()
  })

  test('finds a row by a keyword that is not in its label', () => {
    const ids = searchSettings('font').flatMap((g) => g.rows.map((r) => r.id))
    expect(ids).toContain('appearance-ui-font')
    expect(ids).toContain('terminal-font')
  })

  test('is case-insensitive and ignores diacritics', () => {
    const plain = searchSettings('phim tat').flatMap((g) => g.rows.map((r) => r.id))
    expect(plain).toContain('keyboard-shortcuts')
    expect(searchSettings('PHÍM TẮT').flatMap((g) => g.rows.map((r) => r.id))).toEqual(plain)
  })

  test('every word must match: "terminal font" does not return unrelated rows', () => {
    const ids = searchSettings('terminal font').flatMap((g) => g.rows.map((r) => r.id))
    expect(ids).toContain('terminal-font')
    expect(ids).not.toContain('notify-sound')
  })

  test('a query that matches nothing returns an empty list', () => {
    expect(searchSettings('zzzzqqqq')).toEqual([])
  })
})
