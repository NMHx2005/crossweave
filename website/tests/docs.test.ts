import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { docsPages, parseCommands } from '../src/pages/docs'
import { viDocsCopy } from '../src/content/vi/docs-copy'
import { loadConfig, makeUrls } from '../src/site'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (path: string): string => readFileSync(`${root}${path}`, 'utf8')
const urls = makeUrls(loadConfig({}))
const build = (over: Partial<Parameters<typeof docsPages>[0]> = {}, lang: 'en' | 'vi' = 'en') =>
  docsPages({
    urls,
    readme: read('README.md'),
    security: read('SECURITY.md'),
    concepts: read('website/src/content/concepts.md'),
    cliHelp: read('website/src/content/cli-help.txt'),
    release: { tag: 'v0.5.0', publishedAt: '2026-09-30T10:39:00Z', assets: ['checksums.txt'] },
    imageSize: () => ({ width: 1600, height: 1000 }),
    viDocs: {
      copy: viDocsCopy,
      markdown: {
        install: read('website/src/content/vi/docs/install.md'),
        quickstart: read('website/src/content/vi/docs/quickstart.md'),
        concepts: read('website/src/content/vi/docs/concepts.md'),
        cockpit: read('website/src/content/vi/docs/cockpit.md'),
        configuration: read('website/src/content/vi/docs/configuration.md'),
        security: read('website/src/content/vi/docs/security.md'),
      },
      securityLead: read('website/src/content/vi/docs/security-lead.md'),
    },
    ...over,
  }, lang)
const count = (html: string, re: RegExp): number => [...html.matchAll(re)].length

describe('docsPages', () => {
  const pages = build()

  test('Vietnamese documentation has the same route set with localized titles and page metadata', () => {
    const pagesVi = build({}, 'vi')
    expect(pagesVi.map((p) => p.path)).toEqual(pages.map((p) => `/vi${p.path}`))
    expect(pagesVi.map((p) => p.meta.lang)).toEqual(pages.map(() => 'vi'))
    expect(pagesVi.map((p) => p.meta.title)).not.toEqual(pages.map((p) => p.meta.title))
    expect(pagesVi[0]?.meta.alternates).toEqual({ en: '/docs/', vi: '/vi/docs/' })
  })

  test('eight pages at fixed paths, in English', () => {
    expect(pages.map((p) => p.path)).toEqual(['/docs/', '/docs/install/', '/docs/quickstart/', '/docs/concepts/', '/docs/cockpit/', '/docs/configuration/', '/docs/commands/', '/docs/security/'])
    for (const p of pages) {
      expect(p.meta.lang).toBe('en')
      expect(p.meta.alternates).toEqual({ en: p.path, vi: `/vi${p.path}` })
      expect(p.meta.title.length, p.path).toBeLessThanOrEqual(60)
    }
  })

  test('Vietnamese docs use the same route set and render translated copy', () => {
    const translated = build({}, 'vi')
    expect(translated.map((p) => p.path)).toEqual(pages.map((p) => `/vi${p.path}`))
    expect(translated.map((p) => p.meta.lang)).toEqual(pages.map(() => 'vi'))
    expect(translated.map((p) => p.meta.alternates)).toEqual(pages.map((p) => ({ en: p.path, vi: `/vi${p.path}` })))
    expect(translated.map((p) => /<h1>([^<]+)<\/h1>/.exec(String(p.body))?.[1])).toEqual([
      'Tài liệu', 'Cài đặt', 'Bắt đầu nhanh', 'Khái niệm', 'Ứng dụng Cockpit', 'Cấu hình', 'Tham chiếu lệnh', 'Bảo mật và quyền riêng tư',
    ])
    for (const page of translated) {
      expect(String(page.body), page.path).toContain('Các trang này mô tả nhánh main.')
      expect(String(page.body), page.path).not.toContain('These pages describe the main branch.')
      expect(String(page.body), page.path).toContain('aria-label="Tài liệu"')
    }
  })

  test('each has one h1, real prose, and a sidebar of all eight with the current one marked', () => {
    for (const p of pages) {
      const body = String(p.body)
      expect(count(body, /<h1[ >]/g), p.path).toBe(1)
      expect(body.replace(/<[^>]+>/g, '').trim().length, p.path).toBeGreaterThan(200)
      const nav = body.slice(body.indexOf('<nav class="docs__nav"'), body.indexOf('</nav>'))
      expect(count(nav, /<li><a href="[^"]*docs\/[^"]*"/g), p.path).toBe(8)
      expect(count(body, /aria-current="page"/g), p.path).toBe(1)
      expect(body, p.path).toContain(`href="${urls.path(p.path)}" aria-current="page"`)
    }
  })

  test('every page says it follows main and names the latest published release', () => {
    for (const p of pages) expect(String(p.body), p.path).toContain('The latest published release is v0.5.0')
  })

  test('headings never skip a level and ids do not repeat', () => {
    for (const p of pages) {
      const body = String(p.body)
      const levels = [...body.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]))
      for (let i = 1; i < levels.length; i++) expect((levels[i] ?? 0) - (levels[i - 1] ?? 0), p.path).toBeLessThanOrEqual(1)
      const ids = [...body.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
      expect(new Set(ids).size, p.path).toBe(ids.length)
    }
  })

  test('the install page has the installer line, and the README screenshots become the site\'s own sized copies', () => {
    const install = String(pages.find((p) => p.path === '/docs/install/')?.body)
    expect(install).toContain('curl -fsSL https://raw.githubusercontent.com/NMHx2005/crossweave/main/install.sh')
    const cockpit = String(pages.find((p) => p.path === '/docs/cockpit/')?.body)
    expect(cockpit).toContain('src="/crossweave/img/cockpit-composer.png"')
    expect(cockpit).toMatch(/<img [^>]*alt="[^"]+"[^>]*width="1600" height="1000" loading="lazy">/)
    expect(cockpit).not.toContain('src="docs/images')
  })

  test('repository-relative links go to GitHub, and every link left is either absolute, on the site, or a fragment that exists', () => {
    for (const p of pages) {
      const body = String(p.body)
      const ids = new Set([...body.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))
      for (const m of body.matchAll(/href="([^"]*)"/g)) {
        const href = m[1] ?? ''
        if (href.startsWith('#')) expect(ids.has(href.slice(1)), `${p.path}: ${href}`).toBe(true)
        else expect(/^(https?:|mailto:|\/crossweave\/)/.test(href), `${p.path}: ${href}`).toBe(true)
      }
    }
  })

  test('the command reference lists every command in the CLI fixture', () => {
    const body = String(pages.find((p) => p.path === '/docs/commands/')?.body)
    const commands = parseCommands(read('website/src/content/cli-help.txt'))
    expect(commands.length).toBeGreaterThanOrEqual(15)
    for (const { name } of commands) expect(body, name).toContain(`<code>${name}</code>`)
  })

  test('the fixture is what `cw --help` prints today', () => {
    const run = Bun.spawnSync([process.execPath, 'src/cli/index.ts', '--help'], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 })
    expect(run.exitCode).toBe(0)
    const clean = (text: string): string => text.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim()
    const live = clean(run.stdout.toString().split('\n').slice(1).join('\n'))
    expect(clean(read('website/src/content/cli-help.txt'))).toBe(live)
  })
})

describe('Security & privacy', () => {
  const page = String(build().find((p) => p.path === '/docs/security/')?.body)

  test('is the project policy, with its trust table and the private reporting route, under a lead that says what is and is not sent', () => {
    expect(page).toContain('<h1>Security &amp; privacy</h1>')
    expect(page).toContain('<th scope="col">Input</th>')
    expect(page).toContain('https://github.com/NMHx2005/crossweave/security/advisories/new')
    expect(page).toContain('sends nothing anywhere itself')
    expect(page).toContain('cw config update-check off')
    expect(page).toContain('their own network behaviour')
  })

  test('SECURITY.md no longer names a stale version as the supported one', () => {
    expect(read('SECURITY.md')).not.toMatch(/currently 0\.\d+\.x/)
    expect(read('SECURITY.md')).toContain('Supported version: the latest release')
  })

  test('the real file renders through the site renderer without a lint error, autolinks included', async () => {
    const { lintMarkdown } = await import('../src/markdown')
    expect(() => lintMarkdown(read('SECURITY.md'))).not.toThrow()
    expect(() => lintMarkdown('<https://example.org/x>')).not.toThrow()
    expect(() => lintMarkdown('<div>x</div>')).toThrow(/raw HTML/)
  })
})

describe('Uninstall', () => {
  const install = String(build().find((p) => p.path === '/docs/install/')?.body)

  test('is the last section of the Install page, in an order that leaves nothing running', () => {
    expect(install).toContain('id="uninstall"')
    const steps = install.slice(install.indexOf('id="uninstall"'))
    const order = ['cw hooks remove claude', 'cw session stop', 'cw session rm NAME --yes', 'cw gc', 'cw daemon stop', '~/.local/bin', '~/.crossweave']
    let at = -1
    for (const text of order) {
      const next = steps.indexOf(text)
      expect(next, text).toBeGreaterThan(at)
      at = next
    }
    expect(steps).toContain('keeps ended sessions that still hold unlanded work')
  })
})

describe('links that start with a slash', () => {
  test('in the README they are repository paths, on the generated overview they are already under the base', () => {
    const readme = read('README.md').replace('## Quickstart\n', '## Quickstart\n\nSee [the progress file](/docs/PROGRESS.md).\n')
    const quickstart = String(build({ readme }).find((p) => p.path === '/docs/quickstart/')?.body)
    expect(quickstart).toContain('href="https://github.com/NMHx2005/crossweave/blob/main/docs/PROGRESS.md"')
    const overview = String(build().find((p) => p.path === '/docs/')?.body)
    expect(overview).toContain('href="/crossweave/docs/install/"')
    expect(overview).not.toContain('/crossweave/crossweave/')
  })
})

describe('what must break the build', () => {
  test('a README that lost a documented section', () => {
    expect(() => build({ readme: read('README.md').replace('## Quickstart', '## Getting started') })).toThrow(/## Quickstart/)
  })

  test('a link to a fragment that exists nowhere', () => {
    const readme = read('README.md').replace('## Quickstart\n', '## Quickstart\n\nSee [nothing](#no-such-heading-anywhere).\n')
    expect(() => build({ readme })).toThrow(/no-such-heading-anywhere/)
  })

  test('raw HTML left in a section', () => {
    const readme = read('README.md').replace('## Quickstart\n', '## Quickstart\n\n<div>raw</div>\n')
    expect(() => build({ readme })).toThrow(/raw HTML/)
  })
})

describe('parseCommands', () => {
  test('reads the COMMANDS table of the help text and ignores the rest', () => {
    expect(parseCommands('USAGE cw a|b\n\nCOMMANDS\n\n   a    Does a\n   bb   Does b, with a | pipe\n\nUse cw <command> --help')).toEqual([
      { name: 'a', summary: 'Does a' },
      { name: 'bb', summary: 'Does b, with a | pipe' },
    ])
  })
})
