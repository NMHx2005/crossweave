import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { docsPages, parseCommands } from '../src/pages/docs'
import { loadConfig, makeUrls } from '../src/site'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (path: string): string => readFileSync(`${root}${path}`, 'utf8')
const urls = makeUrls(loadConfig({}))
const build = (over: Partial<Parameters<typeof docsPages>[0]> = {}) =>
  docsPages({
    urls,
    readme: read('README.md'),
    concepts: read('website/src/content/concepts.md'),
    cliHelp: read('website/src/content/cli-help.txt'),
    release: { tag: 'v0.5.0', publishedAt: '2026-09-30T10:39:00Z', assets: ['checksums.txt'] },
    imageSize: () => ({ width: 1600, height: 1000 }),
    ...over,
  })
const count = (html: string, re: RegExp): number => [...html.matchAll(re)].length

describe('docsPages', () => {
  const pages = build()

  test('seven pages at fixed paths, in English', () => {
    expect(pages.map((p) => p.path)).toEqual(['/docs/', '/docs/install/', '/docs/quickstart/', '/docs/concepts/', '/docs/cockpit/', '/docs/configuration/', '/docs/commands/'])
    for (const p of pages) {
      expect(p.meta.lang).toBe('en')
      expect(p.meta.alternates).toEqual({})
      expect(p.meta.title.length, p.path).toBeLessThanOrEqual(60)
    }
  })

  test('each has one h1, real prose, and a sidebar of all seven with the current one marked', () => {
    for (const p of pages) {
      const body = String(p.body)
      expect(count(body, /<h1[ >]/g), p.path).toBe(1)
      expect(body.replace(/<[^>]+>/g, '').trim().length, p.path).toBeGreaterThan(200)
      const nav = body.slice(body.indexOf('<nav class="docs__nav"'), body.indexOf('</nav>'))
      expect(count(nav, /<li><a href="[^"]*docs\/[^"]*"/g), p.path).toBe(7)
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
