import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, treeHashes } from '../build'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const scratch = mkdtempSync(join(tmpdir(), 'cw-site-'))
const options = (out: string, env: Record<string, string | undefined> = {}) => ({ out, env, repoRoot, refreshRelease: false })

const files = (dir: string, prefix = ''): string[] =>
  readdirSync(dir).sort().flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`]))
const pagesOf = (dir: string): string[] => files(dir).filter((f) => f.endsWith('.html'))
const read = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8')

const project = join(scratch, 'project')
const custom = join(scratch, 'custom')
let pages: string[] = []

beforeAll(async () => {
  await build(options(project))
  await build(options(custom, { SITE_DOMAIN: 'crossweave.dev' }))
  pages = pagesOf(project)
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('what a build writes', () => {
  test('every page in both languages where there are two, the assets and the sitemap', () => {
    const all = files(project)
    for (const f of [
      'index.html', 'vi/index.html', 'download/index.html', 'vi/download/index.html', 'changelog/index.html', '404.html',
      'docs/index.html', 'docs/install/index.html', 'docs/quickstart/index.html', 'docs/concepts/index.html', 'docs/cockpit/index.html', 'docs/configuration/index.html', 'docs/commands/index.html',
      'styles.css', 'site.js', 'apple-touch-icon.png', 'sitemap.xml', 'icon.png', 'img/cockpit-sessions.png', 'img/cockpit-composer.png', 'img/cockpit-dashboard.png', 'img/cockpit-rail.png',
    ]) expect(all, f).toContain(f)
    expect(all).not.toContain('CNAME')
    expect(all).not.toContain('robots.txt')
    expect(all).not.toContain('vi/404.html')
  })

  test('a custom domain adds CNAME and robots.txt', () => {
    expect(read(custom, 'CNAME')).toBe('crossweave.dev\n')
    expect(read(custom, 'robots.txt')).toContain('Sitemap: https://crossweave.dev/sitemap.xml')
  })

  test('the sitemap lists every indexable page once, with absolute URLs, and not the 404', () => {
    const urls = [...read(project, 'sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    expect(urls).toHaveLength(pages.length - 1)
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls.every((u) => u?.startsWith('https://nmhx2005.github.io/crossweave/'))).toBe(true)
    expect(urls.join(' ')).not.toContain('404')
  })

  test('the stylesheet is the cockpit theme followed by the site rules', () => {
    const css = read(project, 'styles.css')
    expect(css.startsWith(':root{color-scheme:dark light;')).toBe(true)
    expect(css).toContain('.hero')
  })
})

describe('every page', () => {
  const basePath = '/crossweave/'

  test('every internal link and resource resolves to a file, and every fragment to an id', () => {
    const missing: string[] = []
    for (const page of pages) {
      const html = read(project, page)
      for (const m of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
        const target = m[1] ?? ''
        if (/^(https?:|mailto:)/.test(target)) continue
        if (target.startsWith('#')) {
          if (!html.includes(` id="${target.slice(1)}"`)) missing.push(`${page}: ${target}`)
          continue
        }
        if (!target.startsWith(basePath)) { missing.push(`${page}: ${target} is not under the base`); continue }
        const [path, fragment] = target.slice(basePath.length).split('#') as [string, string | undefined]
        const file = path === '' || path.endsWith('/') ? `${path}index.html` : path
        if (!existsSync(join(project, file))) { missing.push(`${page}: ${target}`); continue }
        if (fragment !== undefined && file.endsWith('.html') && !read(project, file).includes(` id="${fragment}"`)) missing.push(`${page}: ${target}`)
      }
    }
    expect(missing).toEqual([])
  })

  test('nothing is loaded from another origin, and the only script is our own site.js: no inline script, handler, style or javascript: URL', () => {
    for (const page of pages) {
      const html = read(project, page)
      expect(html, page).not.toMatch(/<link[^>]+rel="stylesheet"[^>]+href="https?:/)
      expect(html, page).not.toMatch(/\ssrc="https?:/)
      // One external script, and at most one JSON data block (it is never executed): nothing inline and executable.
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag !== '<script type="application/ld+json">')
      expect(scripts, page).toEqual(['<script src="/crossweave/site.js" defer>'])
      for (const m of html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
        expect(m[1], page).toBe(' type="application/ld+json"')
        expect(() => JSON.parse(m[2] ?? ''), page).not.toThrow()
      }
      expect(html, page).not.toMatch(/\son[a-z]+="/)
      expect(html, page).not.toMatch(/\sstyle="/)
      expect(html, page).not.toContain('javascript:')
    }
  })

  test('one h1, a title of at most 60 characters, unique ids, headings that never skip a level', () => {
    for (const page of pages) {
      const html = read(project, page)
      expect([...html.matchAll(/<h1[ >]/g)], page).toHaveLength(1)
      const title = (/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
      expect(title.length, `${page}: ${title}`).toBeLessThanOrEqual(60)
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
      expect(new Set(ids).size, `${page}: duplicate ids`).toBe(ids.length)
      const levels = [...html.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]))
      for (let i = 1; i < levels.length; i++) expect((levels[i] ?? 0) - (levels[i - 1] ?? 0), page).toBeLessThanOrEqual(1)
    }
  })

  test('every image states alt, width and height; every table has scoped headers', () => {
    for (const page of pages) {
      const html = read(project, page)
      for (const m of html.matchAll(/<img\s[^>]*>/g)) {
        const tag = m[0]
        expect(tag, `${page}: ${tag}`).toMatch(/\salt="/)
        expect(tag, `${page}: ${tag}`).toMatch(/\swidth="\d+"/)
        expect(tag, `${page}: ${tag}`).toMatch(/\sheight="\d+"/)
      }
      for (const m of html.matchAll(/<th(?![a-z])([^>]*)>/g)) expect(m[1], page).toMatch(/scope="(col|row)"/)
    }
  })

  test('hreflang appears only on Home and Download, and points at files that exist', () => {
    for (const page of pages) {
      const html = read(project, page)
      const has = html.includes('hreflang="en"')
      const translated = ['index.html', 'vi/index.html', 'download/index.html', 'vi/download/index.html'].includes(page)
      expect(has, page).toBe(translated)
      for (const m of html.matchAll(/hreflang="[^"]+" href="https:\/\/nmhx2005\.github\.io\/crossweave\/([^"]*)"/g)) {
        const path = m[1] ?? ''
        expect(existsSync(join(project, path === '' || path.endsWith('/') ? `${path}index.html` : path)), `${page} -> ${path}`).toBe(true)
      }
    }
  })

  test('the 404 works from any depth: its resources are absolute and under the base', () => {
    const html = read(project, '404.html')
    expect(html).toContain('href="/crossweave/styles.css"')
    expect(html).toContain('noindex')
  })
})

describe('a custom domain', () => {
  test('no internal link carries the base, and canonicals are on the domain', () => {
    for (const page of pagesOf(custom)) {
      const html = read(custom, page)
      expect(html, page).not.toMatch(/(?:href|src)="\/crossweave\//)
      expect(html, page).toMatch(/rel="canonical" href="https:\/\/crossweave\.dev\//)
    }
  })
})

describe('determinism and safety of the build itself', () => {
  test('two builds of the same commit are identical, file for file', async () => {
    const again = join(scratch, 'again')
    await build(options(again))
    expect(treeHashes(again)).toEqual(treeHashes(project))
  })

  test('it will not clear a directory it did not make', async () => {
    const foreign = join(scratch, 'foreign')
    mkdirSync(foreign)
    writeFileSync(join(foreign, 'precious.txt'), 'keep')
    await expect(build(options(foreign))).rejects.toThrow(/refusing to clear/)
    expect(read(foreign, 'precious.txt')).toBe('keep')
  })

  test('a refresh that fails leaves the manifest byte-identical and the build still succeeds', async () => {
    const manifest = join(scratch, 'release.json')
    copyFileSync(join(repoRoot, 'website', 'release.json'), manifest)
    const before = readFileSync(manifest, 'utf8')
    const out = join(scratch, 'refreshed')
    await build({ ...options(out), manifestPath: manifest, refreshRelease: true, fetcher: (async () => { throw new Error('offline') }) as unknown as typeof fetch, timeoutMs: 50 })
    expect(readFileSync(manifest, 'utf8')).toBe(before)
    expect(existsSync(join(out, 'index.html'))).toBe(true)
  })

  test('a notarized build swaps the warning for the plain line', async () => {
    const out = join(scratch, 'notarized')
    await build({ ...options(out), notarized: true })
    expect(read(out, 'download/index.html')).toContain('Notarized by Apple')
    expect(read(out, 'download/index.html')).not.toContain('xattr')
  })
})
