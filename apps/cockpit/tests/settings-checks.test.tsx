/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, findSection, searchSettings } from '../src/lib/settings-sections'
import { SECTION_ICONS } from '../src/ui/SettingsPage'

describe('the Checks setting', () => {
  test('is a section of the Sessions group, with its one row', () => {
    const section = findSection('checks')
    expect(section?.rows.map((r) => r.id)).toEqual(['checks-auto-run'])
    expect(SETTINGS_GROUPS.find((g) => g.id === 'sessions')?.sections).toContain('checks')
  })

  test('can be found by what a person would type', () => {
    for (const query of ['automatic tests', 'run checks', 'test command']) {
      expect(searchSettings(query).flatMap((g) => g.rows.map((r) => r.id)), query).toContain('checks-auto-run')
    }
  })

  // The page looks icons up by section id in a plain record: a missing entry compiles and renders a blank nav button.
  test('every section of the page has an icon', () => {
    expect(SETTINGS_SECTIONS.filter((s) => SECTION_ICONS[s.id] === undefined).map((s) => s.id)).toEqual([])
  })
})
