import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { en } from '../src/content/en'
import { vi } from '../src/content/vi'
import { diagramSvg } from '../src/diagram'
import { homePage } from '../src/pages/home'
import { loadConfig, makeUrls } from '../src/site'
import type { PageCtx, Release } from '../src/types'

const releasesDir = fileURLToPath(new URL('../../docs/releases/', import.meta.url))
const notes = readdirSync(releasesDir)
  .filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f))
  .map((f) => ({ tag: f.replace(/\.md$/, ''), markdown: readFileSync(`${releasesDir}${f}`, 'utf8') }))

const urls = makeUrls(loadConfig({}))
const published = (tag: string): Release => ({
  tag,
  publishedAt: '2026-09-30T10:39:00Z',
  assets: ['checksums.txt', 'cockpit-darwin-arm64.dmg', 'cw-darwin-arm64'],
  dates: { 'v0.3.0': '2026-09-18', 'v0.4.0': '2026-09-30', 'v0.5.0': '2026-09-30', 'v0.6.0': '2026-10-20' },
})
const ctx = (over: Partial<PageCtx> = {}): PageCtx => ({
  lang: 'en',
  content: en,
  urls,
  release: published('v0.5.0'),
  notarized: false,
  imageSize: () => ({ width: 1600, height: 1000 }),
  notes,
  ...over,
})
const body = (over: Partial<PageCtx> = {}): string => String(homePage(ctx(over)).body)
const count = (html: string, re: RegExp): number => [...html.matchAll(re)].length
const plain = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('the order of the page', () => {
  test('hero (with the pill), how it works, what you get, what is coming, the audience, agents, comparison, releases, questions, the end', () => {
    const html = body()
    const ids = [...html.matchAll(/<(?:section|a|p)\b[^>]*\bid="(pill|hero|how|features|coming|fit|agents|compare|releases|faq|cta)"/g)].map((m) => m[1])
    // The pill sits at the top of the hero, above its headline.
    expect(ids).toEqual(['hero', 'pill', 'how', 'features', 'coming', 'fit', 'agents', 'compare', 'releases', 'faq', 'cta'])
  })

  test('the old history of removals and the etymology are no longer sections of their own', () => {
    const html = body()
    expect(html).not.toContain('What it deliberately does not do')
    expect(html).not.toContain('id="not"')
    expect(html).not.toContain('id="why"')
  })

  test('headings never skip a level, in both languages', () => {
    for (const html of [body(), body({ lang: 'vi', content: vi })]) {
      const levels = [...html.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]))
      expect(levels[0]).toBe(1)
      for (let i = 1; i < levels.length; i++) expect((levels[i] ?? 0) - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1)
    }
  })
})

describe('the announcement pill', () => {
  test('names what is coming while something is newer than the latest release, and goes when it is out', () => {
    const html = body()
    const labels = en.home.features.items.filter((f) => f.since === 'v0.6.0').map((f) => f.label)
    expect(html).toContain(`href="/crossweave/changelog/#v0-6-0"`)
    expect(plain(/<a[^>]*id="pill"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? '')).toBe(`Coming in v0.6.0: ${labels.join(', ')} →`)
    expect(body({ release: published('v0.6.0') })).not.toContain('id="pill"')
  })
})

describe('the hero', () => {
  const html = body()
  test('the installer line is the main path, with a copy button that does nothing until a script wakes it', () => {
    expect(html).toContain('<code class="cmd">curl -fsSL https://raw.githubusercontent.com/NMHx2005/crossweave/main/install.sh | sh</code>')
    expect(html).toMatch(/<button type="button" class="copy" data-copy="curl -fsSL [^"]+" data-copied="Copied" data-failed="[^"]+" hidden>Copy<\/button>/)
    expect(html).toContain('role="status"')
    expect(html).toContain(en.home.hero.installLabel)
  })

  test('the app button goes to the Download page, GitHub is there, and the "Install the CLI" jump is gone', () => {
    expect(html).toContain(`class="btn btn--primary" href="/crossweave/download/">${en.home.hero.appCta}</a>`)
    expect(html).toContain('href="https://github.com/NMHx2005/crossweave"')
    expect(html).not.toContain('href="#install"')
  })

  test('the line under it says the version, its day and where to read what changed', () => {
    expect(plain(/<p class="hero__meta">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '')).toContain('v0.5.0 · 30 Sep 2026')
    expect(html).toContain('href="/crossweave/changelog/#v0-5-0"')
    expect(html).toContain('What&#39;s new')
  })

  test('the subtitle defines landing and names the audience', () => {
    expect(en.home.hero.subtitle).toContain('(merge back)')
    expect(html).toContain('For developers who already run')
  })
})

describe('how it works', () => {
  const html = body()
  test('an inline diagram that is described, and three numbered steps with a command and a picture each', () => {
    expect(html).toContain('<svg ')
    expect(html).toContain(`aria-label="${en.home.how.diagramAlt}"`)
    expect(count(html, /<li class="step"/g)).toBe(3)
    for (const step of en.home.how.steps) {
      expect(html).toContain(`<code class="step__cmd">${step.command}</code>`)
      expect(html).toContain(`alt="${step.imageAlt}"`)
    }
  })
})

describe('the diagram', () => {
  const svg = String(diagramSvg('A described picture'))
  test('is one labelled graphic with no inline style and no script', () => {
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg).toContain('role="img"')
    expect(svg).toContain('aria-label="A described picture"')
    expect(svg).not.toContain('style=')
    expect(svg).not.toContain('<script')
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })
  test('escapes its label', () => {
    expect(String(diagramSvg('"><b>'))).not.toContain('"><b>')
  })
})

describe('what you get', () => {
  test('released features sit in four groups, one title and one sentence each, with the rest behind Limits', () => {
    const html = body({ release: published('v0.5.0') })
    const features = html.slice(html.indexOf('id="features"'), html.indexOf('id="coming"'))
    const released = en.home.features.items.filter((f) => f.since !== 'v0.6.0')
    for (const f of released) {
      expect(features, f.id).toContain(`id="f-${f.id}"`)
      expect(features, f.id).toContain(`<p>${f.summary.replace(/'/g, '&#39;')}</p>`)
    }
    for (const f of en.home.features.items.filter((x) => x.since === 'v0.6.0')) expect(features, f.id).not.toContain(`id="f-${f.id}"`)
    expect(count(features, /<details class="limits">/g)).toBe(released.length)
    expect(features).toContain('>Full limitations on GitHub</a>')
  })

  test('the limits disclosure names its feature for a screen reader', () => {
    const html = body()
    expect(html).toContain(`>${en.home.groups.limits}<span class="sr-only"> · ${en.home.features.items[0]?.title.replace(/'/g, '&#39;')}</span></summary>`)
  })

  test('what is not released yet is in its own strip, and the strip and the pill go away with the release', () => {
    const before = body()
    const coming = before.slice(before.indexOf('id="coming"'), before.indexOf('id="fit"'))
    for (const f of en.home.features.items.filter((x) => x.since === 'v0.6.0')) expect(coming, f.id).toContain(`id="f-${f.id}"`)
    expect(coming).toContain('Coming in v0.6.0')
    const after = body({ release: published('v0.6.0') })
    expect(after).not.toContain('id="coming"')
    for (const f of en.home.features.items) expect(after, f.id).toContain(`id="f-${f.id}"`)
  })
})

describe('is it for you', () => {
  test('both columns, from the content', () => {
    const html = body()
    for (const text of [...en.home.fit.forItems, ...en.home.fit.notItems]) expect(html).toContain(text.replace(/'/g, '&#39;'))
    expect(html).toContain(en.home.fit.forTitle)
    expect(html).toContain(en.home.fit.notTitle)
  })
})

describe('recent releases', () => {
  const html = body()
  const strip = html.slice(html.indexOf('id="releases"'), html.indexOf('id="faq"'))
  test('three published releases newest first with their days, and what is in development', () => {
    expect(strip).toContain('In development: v0.6.0')
    const tags = [...strip.matchAll(/<strong>(v\d+\.\d+\.\d+)<\/strong>/g)].map((m) => m[1])
    expect(tags).toEqual(['v0.5.0', 'v0.4.0', 'v0.3.0'])
    expect(strip).toContain('<time datetime="2026-09-30">30 Sep 2026</time>')
    expect(strip).toContain('<time datetime="2026-09-18">18 Sep 2026</time>')
    expect(strip).toContain('href="/crossweave/changelog/#v0-5-0"')
    expect(strip).toContain('Full changelog →</a>')
  })

  test('nothing is in development once the newest note is published', () => {
    expect(body({ release: published('v0.6.0') })).not.toContain('In development')
  })
})

describe('the end', () => {
  test('the closing button says what it does and goes to the quickstart', () => {
    expect(body()).toContain('href="/crossweave/docs/quickstart/">Read the quickstart</a>')
  })
})

describe('the Vietnamese page', () => {
  test('has the same sections, the pill, the strip and the groups', () => {
    const html = body({ lang: 'vi', content: vi })
    const ids = [...html.matchAll(/<(?:section|a|p)\b[^>]*\bid="(pill|hero|how|features|coming|fit|agents|compare|releases|faq|cta)"/g)].map((m) => m[1])
    // The pill sits at the top of the hero, above its headline.
    expect(ids).toEqual(['hero', 'pill', 'how', 'features', 'coming', 'fit', 'agents', 'compare', 'releases', 'faq', 'cta'])
    expect(html).toContain('Sắp có ở v0.6.0')
    expect(html).toContain('href="/crossweave/vi/download/"')
  })
})
