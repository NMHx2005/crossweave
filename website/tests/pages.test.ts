import { describe, expect, test } from 'bun:test'
import { en } from '../src/content/en'
import { vi } from '../src/content/vi'
import type { Content } from '../src/content/types'
import { changelogPage } from '../src/pages/changelog'
import { downloadPage } from '../src/pages/download'
import { homePage } from '../src/pages/home'
import { notFoundPage } from '../src/pages/notfound'
import { loadConfig, makeUrls } from '../src/site'
import type { PageCtx, Release } from '../src/types'

const urls = makeUrls(loadConfig({}))
const full: Release = {
  tag: 'v0.5.0',
  publishedAt: '2026-09-30T10:39:00Z',
  assets: ['checksums.txt', 'cockpit-darwin-arm64.dmg', 'cockpit-darwin-arm64.zip', 'cw-darwin-arm64', 'cw-darwin-x64', 'cw-linux-x64', 'cwd-darwin-arm64', 'cwd-darwin-x64', 'cwd-linux-x64', 'install.sh'],
}
const ctx = (over: Partial<PageCtx> = {}): PageCtx => ({
  notes: [],
  lang: 'en',
  content: en,
  urls,
  release: full,
  notarized: false,
  imageSize: () => ({ width: 1600, height: 1000 }),
  ...over,
})
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const count = (html: string, re: RegExp): number => [...html.matchAll(re)].length
const GH = 'https://github.com/NMHx2005/crossweave'

describe('the home page', () => {
  const page = homePage(ctx())
  const body = String(page.body)

  test('one h1, the approved headline, and a title and path of its own', () => {
    expect(count(body, /<h1[ >]/g)).toBe(1)
    expect(text(/<h1>([\s\S]*?)<\/h1>/.exec(body)?.[1] ?? '').trim()).toBe('Many agents. One repo. Land what holds up.')
    expect(page.path).toBe('/')
    expect(page.meta.alternates).toEqual({ en: '/', vi: '/vi/' })
    expect(page.meta.canonical).toBe('https://nmhx2005.github.io/crossweave/')
    expect(page.meta.title.length).toBeLessThanOrEqual(60)
  })

  test('the download button goes to the Download page (where the caveat is), the install line is a plain code block', () => {
    expect(body).toContain('class="btn btn--primary" href="/crossweave/download/"')
    expect(body).toContain('<code class="cmd">curl -fsSL https://raw.githubusercontent.com/NMHx2005/crossweave/main/install.sh | sh</code>')
  })

  test('twelve feature cards, each with its qualifier and a link to its limitations file on GitHub', () => {
    expect(count(body, /<article class="card"/g)).toBe(12)
    for (const f of en.home.features.items) {
      expect(body).toContain(f.qualifier.replace(/&/g, '&amp;'))
      expect(body).toContain(`${GH}/blob/main/${f.source}`)
      if (f.source2 !== undefined) expect(body).toContain(`${GH}/blob/main/${f.source2}`)
    }
  })

  test('the comparison is an authored table with a caption and scoped headers', () => {
    expect(body).toContain('<caption>By hand versus crossweave</caption>')
    expect(count(body, /<th scope="col">/g)).toBe(2)
    expect(count(body, /<th scope="row">/g)).toBe(en.home.compare.rows.length)
    expect(body).toContain('<td></td>')
  })

  test('every question is a details element, the launchers are plain text chips, and the only image is the app', () => {
    expect(count(body, /<details data-reveal>/g)).toBe(en.home.faq.items.length)
    for (const name of en.home.agents.names) expect(body).toContain(`>${name}</li>`)
    // The hero's picture, and one still for each of the three steps.
    expect(count(body, /<img /g)).toBe(1 + en.home.how.steps.length)
  })

  test('the hero image says its size and is not lazy', () => {
    expect(body).toContain('src="/crossweave/img/cockpit-sessions.png"')
    expect(body).toMatch(/<img [^>]*alt="crossweave Cockpit[^>]*width="1600" height="1000"/)
    expect(/<img class="hero__shot"[^>]*>/.exec(body)?.[0]).not.toContain('loading="lazy"')
  })

  test('copy is escaped: markup typed into the content never becomes markup', () => {
    const hostile: Content = {
      ...en,
      home: { ...en.home, hero: { ...en.home.hero, headline: '<b>x</b>' }, faq: { ...en.home.faq, items: [{ q: '<i>q</i>', a: '<u>a</u>' }] } },
    }
    const out = String(homePage(ctx({ content: hostile })).body)
    expect(out).not.toContain('<b>x</b>')
    expect(out).not.toContain('<u>a</u>')
    expect(out).not.toContain('<i>q</i>')
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  test('a heading never skips a level', () => {
    const levels = [...body.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]))
    for (let i = 1; i < levels.length; i++) expect((levels[i] ?? 0) - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1)
  })

  test('the Vietnamese page is the same page in Vietnamese, with its own paths', () => {
    const v = homePage(ctx({ lang: 'vi', content: vi }))
    expect(v.path).toBe('/vi/')
    expect(text(/<h1>([\s\S]*?)<\/h1>/.exec(String(v.body))?.[1] ?? '').trim()).toBe('Nhiều agent. Một repo. Merge cái đứng vững.')
    expect(String(v.body)).toContain('href="/crossweave/vi/download/"')
    expect(count(String(v.body), /<article class="card"/g)).toBe(12)
    expect(v.meta.alternates).toEqual({ en: '/', vi: '/vi/' })
  })
})

describe('the download page', () => {
  const body = (over: Partial<PageCtx> = {}): string => String(downloadPage(ctx(over)).body)

  test('links each asset the release has, straight to GitHub', () => {
    const out = body()
    expect(out).toContain(`href="${GH}/releases/download/v0.5.0/cockpit-darwin-arm64.dmg"`)
    expect(out).toContain(`href="${GH}/releases/download/v0.5.0/cw-linux-x64"`)
    expect(out).toContain(`href="${GH}/releases/download/v0.5.0/checksums.txt"`)
  })

  test('an asset the release lacks is not linked as if it existed', () => {
    const out = body({ release: { ...full, assets: ['checksums.txt'] } })
    expect(out).not.toContain('cockpit-darwin-arm64.dmg"')
    expect(out).toContain(`href="${GH}/releases"`)
  })

  test('not notarized: the warning and the exact command show; notarized: the plain line shows instead', () => {
    const warned = body()
    expect(warned).toContain('Not notarized yet')
    expect(warned).toContain('xattr -dr com.apple.quarantine &quot;/Applications/crossweave Cockpit.app&quot;')
    expect(warned).not.toContain('Notarized by Apple')
    const clean = body({ notarized: true })
    expect(clean).toContain('Notarized by Apple')
    expect(clean).not.toContain('xattr')
    expect(clean).not.toContain('Not notarized yet')
  })

  test('says what the installer does, and what it needs, without promising what it does not do', () => {
    const out = text(body())
    expect(out).toContain('unzip')
    expect(out).toContain('does not install the .dmg')
    expect(out).toContain('uses no sudo')
    expect(out).toContain('do not need Bun')
  })

  test('one h1, the version, a Vietnamese twin and hreflang paths', () => {
    const page = downloadPage(ctx())
    expect(count(String(page.body), /<h1[ >]/g)).toBe(1)
    expect(text(String(page.body))).toContain('v0.5.0')
    expect(page.meta.alternates).toEqual({ en: '/download/', vi: '/vi/download/' })
    expect(downloadPage(ctx({ lang: 'vi', content: vi })).path).toBe('/vi/download/')
  })
})

describe('the changelog', () => {
  const notes = [
    { tag: 'v0.9.0', markdown: '## Headline\n\nNine.' },
    { tag: 'v0.10.0', markdown: '## Headline\n\nTen.\n\n## New\n\n- one' },
    { tag: 'v0.2.1', markdown: '## Headline\n\nOld.' },
  ]

  test('newest first by semantic version, headings one level down, ids that never repeat', () => {
    const body = String(changelogPage({ urls, notes, release: { ...full, tag: 'v0.9.0' } }).body)
    expect(body.indexOf('v0.10.0')).toBeLessThan(body.indexOf('v0.9.0'))
    expect(body.indexOf('v0.9.0')).toBeLessThan(body.indexOf('v0.2.1'))
    expect(body).toContain('<h3 id="v0-10-0-headline">Headline</h3>')
    const ids = [...body.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
    expect(count(body, /<h1[ >]/g)).toBe(1)
  })

  test('a tag newer than the latest published release is marked unreleased; every published one carries its date', () => {
    const dated = { ...full, tag: 'v0.9.0', dates: { 'v0.9.0': '2026-09-30', 'v0.10.0': '2026-10-30', 'v0.2.1': '2026-08-19' } }
    const body = String(changelogPage({ urls, notes, release: dated }).body)
    expect(count(body, /Unreleased/g)).toBe(1)
    expect(body).toContain('<time datetime="2026-09-30">2026-09-30</time>')
    expect(body).toContain('<time datetime="2026-08-19">2026-08-19</time>')
    expect(count(body, /<time /g)).toBe(2)
  })

  test('a date is never invented for a release the manifest does not know', () => {
    const body = String(changelogPage({ urls, notes, release: { ...full, tag: 'v0.9.0' } }).body)
    expect(count(body, /<time /g)).toBe(1)
  })

  test('a link to a heading of the same note keeps working after the ids are prefixed, and a link to nothing fails the build', () => {
    const page = changelogPage({ urls, notes: [{ tag: 'v0.9.0', markdown: '## Headline\n\nSee [the upgrade](#upgrading).\n\n## Upgrading\n\nx' }], release: full })
    expect(String(page.body)).toContain('<a href="#v0-9-0-upgrading">the upgrade</a>')
    expect(String(page.body)).toContain('id="v0-9-0-upgrading"')
    expect(() => changelogPage({ urls, notes: [{ tag: 'v0.9.0', markdown: '## Headline\n\n[x](#nope)' }], release: full })).toThrow(/#nope/)
  })

  test('release notes with raw HTML make the build fail rather than being half-rendered', () => {
    expect(() => changelogPage({ urls, notes: [{ tag: 'v1.0.0', markdown: '<div>raw</div>' }], release: full })).toThrow(/raw HTML/)
  })
})

describe('the 404', () => {
  const page = notFoundPage({ urls, en, vi })
  const body = String(page.body)

  test('is one file in both languages, with one h1, not indexed, and only base-aware links', () => {
    expect(page.path).toBe('/404.html')
    expect(page.meta.noindex).toBe(true)
    expect(count(body, /<h1[ >]/g)).toBe(1)
    expect(body).toContain('Page not found')
    expect(body).toContain('Không tìm thấy trang')
    expect(body).toContain('<span lang="vi">Không tìm thấy trang</span>')
    expect(body).toContain('href="/crossweave/"')
    expect(body).toContain('href="/crossweave/vi/"')
    expect(page.meta.alternates).toEqual({})
  })
})
