import { describe, expect, test } from 'bun:test'
import { en } from '../src/content/en'
import { vi } from '../src/content/vi'
import { renderDocument, type PageMeta } from '../src/layout'
import { loadConfig, makeUrls } from '../src/site'
import { html } from '../src/types'

const urls = makeUrls(loadConfig({}))
const meta = (over: Partial<PageMeta> = {}): PageMeta => ({
  lang: 'en',
  path: '/',
  title: 'crossweave',
  description: 'A description.',
  canonical: urls.abs('/'),
  alternates: { en: '/', vi: '/vi/' },
  ogImage: urls.abs('/img/cockpit-sessions.png'),
  ...over,
})
const doc = (m: PageMeta = meta(), content = en): string => String(renderDocument(m, html('<main id="main"><h1>Hi</h1></main>'), { content, urls, version: 'v0.5.0', styleFingerprint: 'layout-test' }))

describe('the head', () => {
  test('the content security policy is the first thing after the charset, and forbids everything not needed', () => {
    const head = doc().slice(doc().indexOf('<head>'))
    // The attribute is entity-escaped; a browser decodes it before it reads the policy.
    const metas = [...head.matchAll(/<meta [^>]*>/g)].map((m) => m[0].replaceAll('&#39;', "'"))
    expect(metas[0]).toContain('charset')
    expect(metas[1]).toContain('http-equiv="Content-Security-Policy"')
    expect(metas[1]).toContain("default-src 'none'")
    expect(metas[1]).toContain("img-src 'self' data:")
    expect(metas[1]).toContain("style-src 'self'")
    expect(metas[1]).toContain("script-src 'self'")
    expect(metas[1]).toContain("media-src 'self'")
    expect(metas[1]).toContain("base-uri 'none'")
    expect(metas[1]).toContain("form-action 'none'")
  })

  test('language, viewport, absolute canonical and absolute Open Graph URLs', () => {
    const out = doc()
    expect(out).toContain('<html lang="en">')
    expect(out).toContain('name="viewport" content="width=device-width, initial-scale=1"')
    expect(out).toContain('<link rel="canonical" href="https://nmhx2005.github.io/crossweave/">')
    expect(out).toContain('property="og:url" content="https://nmhx2005.github.io/crossweave/"')
    expect(out).toContain('property="og:image" content="https://nmhx2005.github.io/crossweave/img/cockpit-sessions.png"')
    expect(out).toContain('name="twitter:card" content="summary_large_image"')
    expect(doc(meta({ ogImage: null }))).not.toContain('og:image')
  })

  test('hreflang pairs only when a page has both languages, with an x-default', () => {
    const out = doc()
    expect(out).toContain('<link rel="alternate" hreflang="en" href="https://nmhx2005.github.io/crossweave/">')
    expect(out).toContain('<link rel="alternate" hreflang="vi" href="https://nmhx2005.github.io/crossweave/vi/">')
    expect(out).toContain('hreflang="x-default"')
    expect(doc(meta({ alternates: {} }))).not.toContain('hreflang')
  })

  test('a title or description with markup is text', () => {
    const out = doc(meta({ title: '<script>x</script>', description: '"><b>' }))
    expect(out).not.toContain('<script>x')
    expect(out).toContain('&lt;script&gt;x&lt;/script&gt;')
  })

  test('noindex only when asked', () => {
    expect(doc()).not.toContain('noindex')
    expect(doc(meta({ noindex: true }))).toContain('<meta name="robots" content="noindex">')
  })
})

describe('the shell', () => {
  test('one external script and no inline one, a skip link first, the stylesheet and icon under the base', () => {
    const out = doc()
    expect([...out.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script src="/crossweave/site.js" defer>'])
    expect(out).toContain('<div class="scroll-progress" aria-hidden="true"></div>')
    expect(out.indexOf('class="skip"')).toBeLessThan(out.indexOf('<main'))
    expect(out).toContain('href="/crossweave/styles.css?v=layout-test"')
    expect(out).toContain('href="/crossweave/icon.png"')
  })

  test('the language switch links to the same page in the other language, and is absent without a translation', () => {
    expect(doc()).toContain('href="/crossweave/vi/"')
    expect(doc(meta({ lang: 'vi', path: '/vi/' }), vi)).toContain('href="/crossweave/"')
    expect(doc(meta({ alternates: {} }))).not.toContain('class="lang"')
  })

  test('the navigation and footer stay in the page language and point to matching routes', () => {
    const vietnamese = doc(meta({ lang: 'vi', path: '/vi/download/', alternates: { en: '/download/', vi: '/vi/download/' } }), vi)
    expect(vietnamese).toContain('href="/crossweave/vi/download/" aria-current="page"')
    expect(vietnamese).toContain('href="/crossweave/vi/docs/"')
    expect(vietnamese).toContain('href="/crossweave/vi/changelog/"')
    expect(vietnamese).toContain('href="/crossweave/vi/docs/security/"')
    expect(vietnamese).not.toContain('Tài liệu và lịch sử thay đổi bằng tiếng Anh')
    expect(doc()).toContain('href="/crossweave/docs/security/"')
  })

  test('the footer carries the version and the licence', () => {
    const out = doc()
    expect(out).toContain('Release v0.5.0')
    expect(out).toContain('MIT licence')
  })

  test('a custom domain drops the base from every link', () => {
    const root = makeUrls(loadConfig({ SITE_DOMAIN: 'crossweave.dev' }))
    const out = String(renderDocument(meta({ canonical: root.abs('/') }), html('<main></main>'), { content: en, urls: root, version: 'v0.5.0', styleFingerprint: 'layout-test' }))
    expect(out).toContain('href="/styles.css?v=layout-test"')
    expect(out).not.toMatch(/(href|src)="\/crossweave\//)
  })
})

describe('the shell, second version', () => {
  const home = (lang: 'en' | 'vi' = 'en') => {
    const content = lang === 'en' ? en : vi
    return String(renderDocument(meta({ lang, path: lang === 'en' ? '/' : '/vi/' }), html('<main id="main"></main>'), { content, urls, version: 'v0.5.0', styleFingerprint: 'layout-test' }))
  }

  test('the footer has a Product and a Project group, a maker line, and the security and contributing links', () => {
    const out = home()
    const footer = /<footer[\s\S]*<\/footer>/.exec(out)?.[0] ?? ''
    expect(footer).toContain(`aria-label="${en.nav.footerLabel}"`)
    expect(footer).toContain(`>${en.footer.groups.product}<`)
    expect(footer).toContain(`>${en.footer.groups.project}<`)
    expect(footer).toContain('href="/crossweave/docs/security/"')
    expect(footer).toContain('href="https://github.com/NMHx2005/crossweave/blob/main/CONTRIBUTING.md"')
    expect(footer).toContain('href="https://github.com/NMHx2005/crossweave/issues"')
    expect(footer).toContain(en.footer.builtBy)
  })

  test('the landmarks are named in the page language', () => {
    expect(home()).toContain(`<nav class="nav" aria-label="${en.nav.mainLabel}">`)
    expect(home('vi')).toContain(`<nav class="nav" aria-label="${vi.nav.mainLabel}">`)
    expect(home('vi')).toContain(`aria-label="${vi.nav.footerLabel}"`)
  })

  test('the header marks GitHub so a phone can leave it to the footer', () => {
    expect(home()).toContain('class="nav__github"')
  })

  test('the sharing tags: image size and description, theme colours, the touch icon', () => {
    const out = String(
      renderDocument(
        { ...meta(), ogImageInfo: { width: 1200, height: 630, alt: 'The headline on a dark card' } },
        html('<main id="main"></main>'),
        { content: en, urls, version: 'v0.5.0', styleFingerprint: 'layout-test' },
      ),
    )
    expect(out).toContain('property="og:image:width" content="1200"')
    expect(out).toContain('property="og:image:height" content="630"')
    expect(out).toContain('property="og:image:alt" content="The headline on a dark card"')
    expect(out).toContain('name="twitter:image:alt" content="The headline on a dark card"')
    expect(out).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)">/)
    expect(out).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)">/)
    expect(out).toContain('<link rel="apple-touch-icon" href="/crossweave/apple-touch-icon.png">')
  })

  test('structured data is a data block, valid JSON, escaped, and only where a page asks for it', () => {
    expect(home()).not.toContain('application/ld+json')
    const out = String(
      renderDocument(
        { ...meta(), jsonLd: { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'x</script><b>' } },
        html('<main id="main"></main>'),
        { content: en, urls, version: 'v0.5.0', styleFingerprint: 'layout-test' },
      ),
    )
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(out)?.[1] ?? ''
    expect(JSON.parse(block)['@type']).toBe('SoftwareApplication')
    expect(block).not.toContain('</script>')
    expect(block).not.toContain('<b>')
  })
})
