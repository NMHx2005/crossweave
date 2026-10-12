import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { headlineOf, inDevelopment, recentReleases } from '../src/releases'
import type { Release } from '../src/types'

const notes = (tags: string[]): Array<{ tag: string; markdown: string }> => tags.map((tag) => ({ tag, markdown: `## Headline\n\nNote for ${tag}. A second sentence.\n` }))
const release = (tag: string, dates: Record<string, string> = {}): Release => ({ tag, publishedAt: '2026-09-30T10:39:00Z', assets: ['checksums.txt'], dates })

describe('headlineOf', () => {
  test('the first sentence of the paragraph under Headline, as plain text', () => {
    expect(headlineOf('## Headline\n\n0.5.0 gives the cockpit a **Settings page** in the manner of [Cursor](https://cursor.com)\'s and `more`. Next sentence.\n\n## New')).toBe(
      "0.5.0 gives the cockpit a Settings page in the manner of Cursor's and more.",
    )
  })

  test('keeps a sentence that runs over several lines, and survives a missing Headline', () => {
    expect(headlineOf('## Headline\n\nOne line\nand another line. Two.\n')).toBe('One line and another line.')
    expect(headlineOf('## New\n\n- x')).toBe('')
    expect(headlineOf('')).toBe('')
  })

  test('reads a translated summary heading when the caller provides its localized label', () => {
    expect(headlineOf('## Điểm nhấn\n\nBản phát hành này giúp công việc an toàn hơn. Câu tiếp theo.', 'Điểm nhấn')).toBe(
      'Bản phát hành này giúp công việc an toàn hơn.',
    )
  })

  test('works on every real release note', () => {
    const dir = fileURLToPath(new URL('../../docs/releases/', import.meta.url))
    for (const name of readdirSync(dir).filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f))) {
      const text = headlineOf(readFileSync(`${dir}${name}`, 'utf8'))
      expect(text.length, name).toBeGreaterThan(20)
      expect(text, name).not.toMatch(/[*`\[\]]/)
    }
  })
})

describe('recentReleases', () => {
  const all = notes(['v0.2.1', 'v0.10.0', 'v0.9.0', 'v0.6.0', 'v0.8.0'])
  test('published only, newest first by semantic version, at most the limit, with the date or null', () => {
    const out = recentReleases(all, release('v0.9.0', { 'v0.9.0': '2026-10-01', 'v0.8.0': '2026-09-20' }), 3)
    expect(out.map((r) => r.tag)).toEqual(['v0.9.0', 'v0.8.0', 'v0.6.0'])
    expect(out.map((r) => r.date)).toEqual(['2026-10-01', '2026-09-20', null])
    expect(out[0]?.headline).toBe('Note for v0.9.0.')
  })
})

describe('inDevelopment', () => {
  test('is the newest tag above the latest published release, or null', () => {
    expect(inDevelopment(notes(['v0.5.0', 'v0.10.0', 'v0.9.0']), release('v0.5.0'))).toBe('v0.10.0')
    expect(inDevelopment(notes(['v0.5.0', 'v0.4.0']), release('v0.5.0'))).toBeNull()
  })
})
