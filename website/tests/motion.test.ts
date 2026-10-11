import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { en } from '../src/content/en'
import { vi } from '../src/content/vi'
import { homePage } from '../src/pages/home'
import { downloadPage } from '../src/pages/download'
import { renderDocument } from '../src/layout'
import { loadConfig, makeUrls } from '../src/site'
import { html, type PageCtx } from '../src/types'

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const css = read('../src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '')
const script = read('../public/reveal.js')

// ---- the script -------------------------------------------------------------------------------------------------------------------

interface FakeEl {
  top: number
  classes: Set<string>
  classList: { add(name: string): void }
  getBoundingClientRect(): { top: number }
}
const el = (top: number): FakeEl => {
  const classes = new Set<string>()
  return { top, classes, classList: { add: (n: string) => void classes.add(n) }, getBoundingClientRect: () => ({ top }) }
}

function run(targets: FakeEl[], withObserver = true): { html: { dataset: Record<string, string> }; observed: FakeEl[]; unobserved: FakeEl[]; fire: (target: FakeEl, isIntersecting: boolean) => void; options: unknown } {
  const html = { dataset: {} as Record<string, string> }
  const observed: FakeEl[] = []
  const unobserved: FakeEl[] = []
  let callback: (entries: Array<{ target: FakeEl; isIntersecting: boolean }>) => void = () => undefined
  let options: unknown
  class Observer {
    constructor(cb: typeof callback, opts: unknown) {
      callback = cb
      options = opts
    }
    observe(target: FakeEl): void { observed.push(target) }
    unobserve(target: FakeEl): void { unobserved.push(target) }
  }
  const win: Record<string, unknown> = { innerHeight: 800 }
  if (withObserver) win['IntersectionObserver'] = Observer
  const doc = {
    documentElement: html,
    querySelectorAll: (selector: string) => (selector === '[data-reveal]:not(.is-visible)' ? targets.filter((t) => !t.classes.has('is-visible')) : []),
  }
  new Function('window', 'document', script)(win, doc)
  return { html, observed, unobserved, fire: (target, isIntersecting) => callback([{ target, isIntersecting }]), get options() { return options } }
}

describe('reveal.js', () => {
  test('without IntersectionObserver it arms nothing, so nothing is ever hidden', () => {
    const a = el(2000)
    const out = run([a], false)
    expect(out.html.dataset).toEqual({})
    expect(a.classes.size).toBe(0)
  })

  test('what is already on screen is marked visible before arming, so arming cannot flash it away', () => {
    const onScreen = el(100)
    const nearFold = el(719)
    const below = el(2000)
    const out = run([onScreen, nearFold, below])
    expect([...onScreen.classes]).toEqual(['is-visible'])
    expect([...nearFold.classes]).toEqual(['is-visible'])
    expect(below.classes.size).toBe(0)
    expect(out.html.dataset['revealReady']).toBe('')
    expect(out.observed).toEqual([below])
  })

  test('a block is revealed once, when it enters, and then no longer watched', () => {
    const below = el(2000)
    const out = run([below])
    out.fire(below, false)
    expect(below.classes.size).toBe(0)
    out.fire(below, true)
    expect([...below.classes]).toEqual(['is-visible'])
    expect(out.unobserved).toEqual([below])
  })

  test('it arms even when there is nothing below the fold', () => {
    expect(run([]).html.dataset['revealReady']).toBe('')
  })
})

// ---- the stylesheet ---------------------------------------------------------------------------------------------------------------

/** Top-level blocks and, recursively, the rules inside at-rules, each with the chain of at-rule preludes around it. */
function rulesOf(text: string, chain: string[] = []): Array<{ selector: string; body: string; chain: string[] }> {
  const out: Array<{ selector: string; body: string; chain: string[] }> = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    let depth = 1
    let j = open + 1
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') depth--
      j++
    }
    const prelude = text.slice(i, open).trim()
    const body = text.slice(open + 1, j - 1)
    if (prelude.startsWith('@')) {
      if (!prelude.startsWith('@keyframes')) out.push(...rulesOf(body, [...chain, prelude]))
    } else out.push({ selector: prelude, body, chain })
    i = j
  }
  return out
}

describe('the motion in the stylesheet', () => {
  const rules = rulesOf(css)

  test('only a script that has armed itself can hide anything, and only when motion is welcome', () => {
    // A closed <details> hides its answer by design (`details[open]` shows it): that is state the reader controls, not a reveal.
    const hiding = rules.filter((r) => !r.selector.includes('::details-content') && (/opacity:\s*0\b/.test(r.body) || /clip-path:\s*inset\(0 0 100%/.test(r.body)))
    expect(hiding.length).toBeGreaterThan(0)
    for (const r of hiding) {
      expect(r.selector, r.selector).toContain('html[data-reveal-ready]')
      expect(r.chain.join(' '), r.selector).toContain('prefers-reduced-motion: no-preference')
    }
  })

  test('every animation and transition lives under no-preference (reduced motion gets none), and a backstop flattens the rest', () => {
    for (const r of rules) {
      if (!/\banimation(-name)?\s*:|\btransition\s*:/.test(r.body)) continue
      if (r.chain.some((c) => c.includes('prefers-reduced-motion: reduce'))) continue
      expect(r.chain.join(' '), r.selector).toContain('prefers-reduced-motion: no-preference')
    }
    const reduce = rules.filter((r) => r.chain.some((c) => c.includes('prefers-reduced-motion: reduce')))
    expect(reduce.map((r) => r.body).join(' ')).toMatch(/animation:\s*none\s*!important/)
    expect(reduce.map((r) => r.body).join(' ')).toMatch(/transition:\s*none\s*!important/)
  })

  test('keyframes animate only what the compositor can do cheaply (plus the FAQ height)', () => {
    const allowed = new Set(['opacity', 'transform', 'translate', 'filter', 'clip-path'])
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
      const start = (m.index ?? 0) + m[0].length
      let depth = 1
      let end = start
      while (end < css.length && depth > 0) {
        if (css[end] === '{') depth++
        else if (css[end] === '}') depth--
        end++
      }
      const props = [...css.slice(start, end - 1).matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1] ?? '')
      for (const p of props) expect(allowed.has(p), `@keyframes ${m[1]} animates ${p}`).toBe(true)
    }
  })

  test('the headline words, and the staggered items, have their delays in the stylesheet (no inline style attributes)', () => {
    for (let n = 1; n <= 16; n++) expect(css, `word ${n}`).toContain(`.word-mask:nth-child(${n})`)
    for (let n = 2; n <= 12; n++) expect(css, `item ${n}`).toContain(`.reveal-item:nth-child(${n})`)
  })

  test('a scroll bar that grows with the page, only where the browser can drive it and motion is welcome', () => {
    const rule = rules.find((r) => r.selector === '.scroll-progress' && r.chain.some((c) => c.includes('animation-timeline')))
    expect(rule?.body).toContain('animation-timeline: scroll(root)')
    expect(rule?.chain.join(' ')).toContain('prefers-reduced-motion: no-preference')
    expect(rules.find((r) => r.selector === '.scroll-progress' && r.chain.length === 0)?.body).toContain('display: none')
  })

  test('printing shows everything', () => {
    const print = rules.filter((r) => r.chain.some((c) => c.startsWith('@media print')))
    expect(print.map((r) => r.body).join(' ')).toContain('opacity: 1')
  })
})

// ---- the markup -------------------------------------------------------------------------------------------------------------------

const urls = makeUrls(loadConfig({}))
const ctx = (over: Partial<PageCtx> = {}): PageCtx => ({
  notes: [],
  lang: 'en',
  content: en,
  urls,
  release: { tag: 'v0.5.0', publishedAt: '2026-09-30T10:39:00Z', assets: ['checksums.txt'] },
  notarized: false,
  imageSize: () => ({ width: 1600, height: 1000 }),
  ...over,
})
const plain = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

describe('the header that stays with you', () => {
  const rules = rulesOf(css)
  const rule = (selector: string, chain: string[] = []) => rules.find((r) => r.selector === selector && r.chain.join('|') === chain.join('|'))

  test('is sticky at the top, opaque, above the content, and anchors leave room for it', () => {
    const header = rule('.site-header')
    expect(header?.body).toContain('position: sticky')
    expect(header?.body).toContain('top: 0')
    expect(header?.body).toContain('background: var(--cw-surface)')
    expect(header?.body).toMatch(/z-index:\s*\d+/)
    expect(rule('html')?.body).toMatch(/scroll-padding-top:\s*[\d.]+rem/)
  })

  test('drops in once on load, only where motion is welcome, and holds still while a page change cross-fades', () => {
    const noPref = ['@media (prefers-reduced-motion: no-preference)']
    expect(rule('.site-header', noPref)?.body).toMatch(/animation:\s*header-in /)
    expect(rule('.site-header', noPref)?.body).toContain('view-transition-name: site-header')
    expect(css).toMatch(/@keyframes header-in\s*\{\s*from\s*\{[^}]*translate:\s*0 -100%/)
  })

  test('the progress bar is the header\'s own bottom edge', () => {
    const bar = rules.find((r) => r.selector === '.scroll-progress' && r.chain.some((c) => c.includes('animation-timeline')))
    expect(bar?.body).toContain('position: absolute')
    expect(bar?.body).not.toContain('position: fixed')
  })

  test('the markup puts the bar inside the header, after the navigation', () => {
    const out = String(
      renderDocument(
        { lang: 'en', path: '/', title: 't', description: 'd', canonical: urls.abs('/'), alternates: {}, ogImage: null },
        html('<main id="main"></main>'),
        { content: en, urls, version: 'v0.5.0' },
      ),
    )
    const header = /<header class="site-header">([\s\S]*?)<\/header>/.exec(out)?.[1] ?? ''
    expect(header).toContain('<nav class="nav"')
    expect(header.indexOf('</nav>')).toBeLessThan(header.indexOf('class="scroll-progress"'))
  })
})

describe('the markup that carries the motion', () => {
  test.each([['en', en, 'en'], ['vi', vi, 'vi']] as const)('%s: the headline is split into masked words and still reads as one sentence', (_n, content, lang) => {
    const body = String(homePage(ctx({ lang, content })).body)
    const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(body)?.[1] ?? ''
    const words = [...h1.matchAll(/<span class="word-mask"><span class="word">([^<]+)<\/span><\/span>/g)].map((m) => m[1])
    expect(words.join(' ')).toBe(content.home.hero.headline)
    expect(words.length).toBeLessThanOrEqual(16)
    expect(plain(h1)).toBe(content.home.hero.headline)
  })

  test('the hero image sits in a media wrapper that is uncovered on load, and keeps its size and its alt', () => {
    const body = String(homePage(ctx()).body)
    expect(body).toMatch(/<div class="hero__media"><img class="hero__shot"[^>]*alt="crossweave Cockpit[^>]*width="1600" height="1000"[^>]*><\/div>/)
  })

  test('sections, cards, answers and the table wait to be revealed; the chips are a staggered group', () => {
    const body = String(homePage(ctx()).body)
    expect([...body.matchAll(/<article class="card" data-reveal /g)]).toHaveLength(12)
    expect([...body.matchAll(/<details data-reveal>/g)]).toHaveLength(en.home.faq.items.length)
    expect(body).toContain('<ul class="chips" data-reveal="group">')
    for (const name of en.home.agents.names) expect(body).toContain(`<li class="reveal-item">${name}</li>`)
    expect(body).toContain('class="section__title" data-reveal')
    expect(body).toContain('class="table-wrap" data-reveal')
  })

  test('the download page reveals its blocks too', () => {
    const body = String(downloadPage(ctx()).body)
    expect([...body.matchAll(/data-reveal/g)].length).toBeGreaterThanOrEqual(3)
  })
})
