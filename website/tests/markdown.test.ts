import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { lintMarkdown, renderMarkdown } from '../src/markdown'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const shot = { rewriteImage: (src: string) => (src === '/img/shot.png' ? { src, width: 100, height: 50 } : null) }

describe('the golden fixture', () => {
  test('renders to the HTML that was written by hand, not copied from the renderer', () => {
    expect(String(renderMarkdown(fixture('markdown-all.md'), shot).html)).toBe(fixture('markdown-all.html'))
  })
})

describe('hostile input stays inert', () => {
  const html = (md: string, options = {}): string => String(renderMarkdown(md, options).html)

  test('raw HTML is dropped and counted', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>\n\n<script>bad()</script>\n\ntext')
    expect(out.html).not.toContain('onerror')
    expect(out.html).not.toContain('<img')
    expect(out.html).not.toContain('<script')
    expect(out.droppedHtml).toBeGreaterThanOrEqual(2)
  })

  test('an unterminated tag is text or nothing, never live markup', () => {
    expect(html('<div class="x"\n\nafter')).not.toMatch(/<div/)
  })

  test.each([
    ['javascript:alert(1)'],
    ['  JaVaScRiPt:alert(1)'],
    ['java\tscript:alert(1)'],
    ['data:text/html,x'],
    ['vbscript:x'],
    ['//evil.example/x'],
    ['file:///etc/hosts'],
  ])('a link to %s keeps its text and loses its href', (href) => {
    const out = html(`[click](<${href}>)`)
    expect(out).toContain('click')
    expect(out).not.toContain('href')
  })

  test('an image that is not one of the site\'s own is dropped by default', () => {
    expect(html('![x](https://evil.example/p.png)')).not.toContain('<img')
    expect(html('![x](/img/shot.png)')).not.toContain('<img')
  })

  test('a title cannot break out of its attribute', () => {
    const out = html('[a](https://example.org "x\\" onmouseover=\\"alert(1)<")')
    // The hostile words are still there, as text inside one quoted attribute: nothing outside the quotes.
    expect(out).toMatch(/^<p><a href="https:\/\/example\.org" title="[^"]*">a<\/a><\/p>\n$/)
    expect(out).toContain('&quot;')
  })

  test('markup typed into a heading is shown as text, and the slug comes from that text', () => {
    const out = renderMarkdown('# A <b>x</b> & "y"')
    expect(out.html).not.toContain('<b>')
    expect(out.html).toContain('A &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;')
    expect(out.headings[0]).toEqual({ level: 1, text: 'A <b>x</b> & "y"', id: 'a-b-x-b-y' })
  })
})

describe('what is allowed', () => {
  test.each([['https://example.org/a'], ['http://example.org'], ['mailto:a@b.co'], ['/docs/'], ['#frag'], ['../x'], ['docs/PROGRESS.md']])('a link to %s keeps its href', (href) => {
    expect(renderMarkdown(`[a](${href})`).html).toContain(`href="${href}"`)
  })

  test('rewriteLink is applied, and its result is checked again', () => {
    expect(renderMarkdown('[a](docs/x.md)', { rewriteLink: (h) => `https://github.com/o/r/blob/main/${h}` }).html).toContain('href="https://github.com/o/r/blob/main/docs/x.md"')
    expect(renderMarkdown('[a](docs/x.md)', { rewriteLink: () => 'javascript:alert(1)' }).html).not.toContain('href')
  })
})

describe('escaping happens once', () => {
  test.each([['a < b'], ['`a < b`'], ['```\na < b\n```']])('a "<" in %j is escaped exactly once', (md) => {
    const out = renderMarkdown(md).html
    expect(out).toContain('a &lt; b')
    expect(out).not.toContain('&amp;lt;')
  })

  test('ampersands and quotes in prose and in code', () => {
    const out = renderMarkdown('Tom & "Jerry"\n\n```\nx && y\n```').html
    expect(out).toContain('Tom &amp; &quot;Jerry&quot;')
    expect(out).toContain('x &amp;&amp; y')
  })
})

describe('headings', () => {
  test('ids come from the plain text, duplicates are numbered, symbols fall back to a name', () => {
    const out = renderMarkdown('# Install\n\n## Install\n\n### !!!\n\n## Install')
    expect(out.headings.map((h) => h.id)).toEqual(['install', 'install-2', 'section', 'install-3'])
    expect(out.html).toContain('<h2 id="install-2">Install</h2>')
  })
})

describe('idPrefix', () => {
  test('keeps the ids of several documents on one page apart', () => {
    const out = renderMarkdown('## Headline\n\n## Headline', { idPrefix: 'v0-6-0-' })
    expect(out.headings.map((h) => h.id)).toEqual(['v0-6-0-headline', 'v0-6-0-headline-2'])
    expect(String(out.html)).toContain('<h2 id="v0-6-0-headline">')
  })
})

describe('lintMarkdown', () => {
  test.each([['- [ ] todo'], ['- [x] done'], ['text[^1]'], ['$$x$$'], ['<div>block</div>'], ['  <p align="center">x</p>']])('refuses %j', (source) => {
    expect(() => lintMarkdown(source)).toThrow()
  })

  test('names the line', () => {
    expect(() => lintMarkdown('fine\n\n- [ ] todo')).toThrow(/line 3/)
  })

  test('leaves code fences alone and accepts the fixture and every release note', () => {
    expect(() => lintMarkdown('```html\n<div>ok in code</div>\n```')).not.toThrow()
    expect(() => lintMarkdown(fixture('markdown-all.md'))).not.toThrow()
    const dir = new URL('../../docs/releases/', import.meta.url).pathname
    for (const name of readdirSync(dir).filter((f) => /^v\d.*\.md$/.test(f))) {
      expect(() => lintMarkdown(readFileSync(`${dir}${name}`, 'utf8')), name).not.toThrow()
    }
  })
})

describe('heading ids against hand-made collisions', () => {
  test('a heading literally called "Install 2" cannot take the second "Install"\'s id, and "Main" cannot take the shell\'s', () => {
    const ids = renderMarkdown('## Install\n\n## Install\n\n## Install 2\n\n## Main').headings.map((h) => h.id)
    expect(ids).toEqual(['install', 'install-2', 'install-2-2', 'main-2'])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
