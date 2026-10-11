import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { en } from '../src/content/en'
import { vi } from '../src/content/vi'
import type { Content } from '../src/content/types'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const both: Array<[string, Content]> = [['en', en], ['vi', vi]]

/** Every string in a value, with the path it was found at. Functions are called with a sample so their text is checked too. */
function strings(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]]
  // Functions are copy too (a pill, a release line): call them with sample arguments of the shapes they take.
  if (typeof value === 'function') return strings((value as (...a: unknown[]) => unknown)('v0.0.0', ['one', 'two']), `${path}()`)
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`))
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, path === '' ? k : `${path}.${k}`))
  return []
}

describe('the two languages are the same page in two voices', () => {
  test('same number of features, limits, table rows, questions and the same launcher names', () => {
    expect(vi.home.features.items.map((f) => f.id)).toEqual(en.home.features.items.map((f) => f.id))
    expect(en.home.features.items).toHaveLength(12)
    expect(vi.home.not.items).toHaveLength(en.home.not.items.length)
    expect(en.home.not.items).toHaveLength(5)
    expect(vi.home.compare.rows).toHaveLength(en.home.compare.rows.length)
    expect(en.home.compare.rows).toHaveLength(5)
    expect(vi.home.faq.items).toHaveLength(en.home.faq.items.length)
    expect(en.home.faq.items).toHaveLength(16)
    expect(vi.home.agents.names).toEqual(en.home.agents.names)
  })

  test('facts are shared, not translated: sources, release of origin and the install line', () => {
    for (const [i, f] of en.home.features.items.entries()) {
      const v = vi.home.features.items[i]
      expect(v?.source).toBe(f.source)
      expect(v?.source2).toBe(f.source2)
      expect(v?.since).toBe(f.since)
    }
    expect(vi.download.cli.installLine).toBe(en.download.cli.installLine)
  })

  test('the Vietnamese page does not carry the English headline', () => {
    expect(strings(vi).some(([, s]) => s.includes(en.home.hero.headline))).toBe(false)
  })
})

describe('the story-led home page has all its words in both languages', () => {
  test.each(both)('%s: every feature has a group, one short sentence and a pill label', (_name, content) => {
    for (const f of content.home.features.items) {
      expect(['run', 'watch', 'land', 'review'], f.id).toContain(f.group)
      expect(f.summary.length, `${f.id}: ${f.summary}`).toBeGreaterThan(20)
      expect(f.summary.length, `${f.id}: ${f.summary}`).toBeLessThanOrEqual(120)
      expect(f.label.length, f.id).toBeGreaterThan(2)
      expect(f.label.length, f.id).toBeLessThanOrEqual(30)
    }
    for (const group of ['run', 'watch', 'land', 'review'] as const) {
      expect(content.home.features.items.some((f) => f.group === group), group).toBe(true)
      expect(content.home.groups.names[group].length, group).toBeGreaterThan(0)
    }
  })

  test('the groups are the same in both languages', () => {
    expect(vi.home.features.items.map((f) => f.group)).toEqual(en.home.features.items.map((f) => f.group))
  })

  test.each(both)('%s: three steps with a command and a picture description, an audience in two columns, and the pill', (_name, content) => {
    expect(content.home.how.steps).toHaveLength(3)
    for (const step of content.home.how.steps) {
      expect(step.command.length).toBeGreaterThan(2)
      expect(step.imageAlt.length).toBeGreaterThan(10)
    }
    expect(content.home.fit.forItems.length).toBeGreaterThanOrEqual(3)
    expect(content.home.fit.notItems.length).toBeGreaterThanOrEqual(3)
    expect(content.home.fit.forItems.length).toBeLessThanOrEqual(5)
    expect(content.home.pill('v0.6.0', ['a', 'b'])).toContain('v0.6.0')
    expect(content.home.pill('v0.6.0', ['a', 'b'])).toContain('a, b')
    expect(content.home.hero.metaRelease('v0.5.0', '30 Sep 2026')).toContain('v0.5.0')
    expect(content.home.hero.videoTranscript.steps).toHaveLength(5)
    expect(content.home.hero.videoNote).toContain('v0.6.0')
  })

  test('the commands the steps show are real', () => {
    const commands = en.home.how.steps.map((s) => s.command)
    expect(commands).toEqual(['cw session new api', 'claude', 'cw converge status'])
    expect(en.home.how.steps[2]?.text).toContain('cw land session api --yes')
  })

  test('the landing FAQ is careful: a clean checkout, a conflict stops it, uncommitted work is not kept', () => {
    const answer = en.home.faq.items.find((f) => f.q.includes('landing do'))?.a ?? ''
    for (const word of ['clean', 'conflict', 'uncommitted', 'squash']) expect(answer, word).toContain(word)
  })
})

describe('every claim carries its limit and can be traced', () => {
  test.each(both)('%s: each feature has a qualifier, an existing source and a semantic-version origin', (_name, content) => {
    for (const f of content.home.features.items) {
      expect(f.qualifier.trim().length, f.id).toBeGreaterThan(0)
      expect(existsSync(`${root}${f.source}`), `${f.id}: ${f.source}`).toBe(true)
      if (f.source2 !== undefined) expect(existsSync(`${root}${f.source2}`), `${f.id}: ${f.source2}`).toBe(true)
      expect(f.since, f.id).toMatch(/^v\d+\.\d+\.\d+$/)
      expect(f.nextBadge('v0.6.0'), f.id).toContain('v0.6.0')
    }
  })
})

describe('the copy is finished plain text', () => {
  test.each(both)('%s: nothing is empty, unfinished or markup', (_name, content) => {
    for (const [path, text] of strings(content)) {
      if (path.endsWith('headings[0]')) continue // the compare table's first heading is the row-label column and is deliberately empty
      expect(text.trim().length, path).toBeGreaterThan(0)
      expect(text, path).not.toMatch(/\b(TODO|TBD)\b/)
      // Copy is plain text; markup is the page function's job. `<platform>` is a placeholder the reader replaces, not a tag.
      expect(text.replaceAll('<platform>', ''), path).not.toContain('<')
    }
  })

  test('the English headline is the one the owner approved', () => {
    expect(en.home.hero.headline).toBe('Many agents. One repo. Land what holds up.')
  })

  test.each(both)('%s: what is said about data says there is no telemetry and names the network uses', (_name, content) => {
    const answer = content.home.faq.items[4]?.a ?? ''
    expect(answer).toContain('telemetry')
    expect(answer).toContain('cw update')
  })
})
