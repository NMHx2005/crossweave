import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { imageSize } from '../src/images'
import { prepareReadmeMarkdown, sectionsOf, shiftHeadings } from '../src/readme'
import { fileURLToPath } from 'node:url'

const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
const WANTED = ['Install', 'Quickstart', 'Cockpit (desktop)', 'Configuration'] as const

describe('sectionsOf', () => {
  test('returns the four documented sections of the real README, each non-empty and not running into the next', () => {
    const sections = sectionsOf(README, WANTED)
    for (const name of WANTED) {
      expect(sections[name]?.trim().length, name).toBeGreaterThan(40)
      expect(sections[name], name).not.toMatch(/^## /m)
    }
    expect(sections['Install']).toContain('curl -fsSL')
    expect(sections['Quickstart']).toContain('cw init')
  })

  test('a README that lost or renamed a heading fails the build, naming it', () => {
    expect(() => sectionsOf('# x\n\n## Setup\n\ntext', ['Install'])).toThrow(/## Install/)
    expect(() => sectionsOf(README.replace('## Quickstart', '## Getting started'), WANTED)).toThrow(/## Quickstart/)
  })

  test('a "## " line inside a code fence is not a heading', () => {
    const readme = '## Install\n\nbefore\n\n```bash\n## not a heading\n```\n\nafter\n\n## Next\n\nx'
    const body = sectionsOf(readme, ['Install'])['Install'] ?? ''
    expect(body).toContain('## not a heading')
    expect(body).toContain('after')
    expect(body).not.toContain('Next')
  })
})

describe('prepareReadmeMarkdown', () => {
  test('turns the centred screenshot paragraphs into markdown images and their captions into text', () => {
    const src = [
      '<p align="center"><img src="docs/images/cockpit-composer.png" alt="A" width="440"> <img src="docs/images/cockpit-dashboard.png" alt="B" width="440"></p>',
      '<p align="center"><sub>Screenshot of <code>acme-api</code>.</sub></p>',
    ].join('\n\n')
    const out = prepareReadmeMarkdown(src)
    expect(out).toContain('![A](docs/images/cockpit-composer.png)')
    expect(out).toContain('![B](docs/images/cockpit-dashboard.png)')
    expect(out).toContain('Screenshot of `acme-api`.')
    expect(out).not.toMatch(/<\/?(p|img|sub|code)\b/)
  })

  test('leaves fenced code alone, even when it looks like HTML', () => {
    const src = '```html\n<p align="center"><img src="x.png"></p>\n```'
    expect(prepareReadmeMarkdown(src)).toBe(src)
  })

  test('the four real sections leave nothing the renderer cannot take', async () => {
    const { lintMarkdown } = await import('../src/markdown')
    for (const [name, body] of Object.entries(sectionsOf(README, WANTED))) {
      expect(() => lintMarkdown(prepareReadmeMarkdown(body)), name).not.toThrow()
    }
  })
})

describe('shiftHeadings', () => {
  test('moves headings outside code fences and never past h6 or above h1', () => {
    expect(shiftHeadings('### A\n\n```\n### code\n```\n\n#### B', -1)).toBe('## A\n\n```\n### code\n```\n\n### B')
    expect(shiftHeadings('## A\n###### Z', 1)).toBe('### A\n###### Z')
    expect(shiftHeadings('# A', -1)).toBe('# A')
  })
})

describe('imageSize', () => {
  test('reads the real width and height from the PNG header of the committed copies', () => {
    expect(imageSize(fileURLToPath(new URL('../public/img/cockpit-sessions.png', import.meta.url)))).toEqual({ width: 1600, height: 1000 })
    expect(imageSize(fileURLToPath(new URL('../public/icon.png', import.meta.url)))).toEqual({ width: 256, height: 256 })
  })

  test('refuses a file that is not a PNG', () => {
    expect(() => imageSize(fileURLToPath(new URL('../release.json', import.meta.url)))).toThrow(/PNG/)
  })
})
