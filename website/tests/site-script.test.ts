import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const script = readFileSync(fileURLToPath(new URL('../public/site.js', import.meta.url)), 'utf8')

type Listener = (...args: unknown[]) => void

interface FakeButton {
  hidden: boolean
  textContent: string
  nextElementSibling: { textContent: string }
  getAttribute(name: string): string | null
  addEventListener(type: string, fn: Listener): void
  click(): void
}

function button(attrs: Record<string, string>): FakeButton {
  const listeners: Listener[] = []
  const self: FakeButton = {
    hidden: true,
    textContent: 'Copy',
    nextElementSibling: { textContent: '' },
    getAttribute: (name) => attrs[name] ?? null,
    addEventListener: (_type, fn) => void listeners.push(fn),
    click: () => listeners.forEach((fn) => fn()),
  }
  return self
}

interface FakeToggle {
  hidden: boolean
  textContent: string
  getAttribute(name: string): string | null
  addEventListener(type: string, fn: Listener): void
  click(): void
}
interface FakeClip {
  paused: boolean
  controls: boolean
  plays: number
  pauses: number
  nextElementSibling: FakeToggle | null
  play?: () => Promise<void>
  pause?: () => void
}

interface FakeDiagramTarget {
  inside: boolean
  getAttribute(name: string): string | null
  closest(selector: string): FakeDiagramTarget | null
}

interface FakeExplorer {
  output: { textContent: string; getAttribute(name: string): string | null }
  listeners: Record<string, Listener[]>
  addEventListener(type: string, fn: Listener): void
  querySelector(selector: string): FakeExplorer['output'] | null
  contains(node: unknown): boolean
  fire(type: string, event: Record<string, unknown>): void
}

interface FakeSearchElement {
  hidden: boolean
  value: string
  textContent: string
  className: string
  href: string
  id?: string
  disabled?: boolean
  options?: Array<{ value: string }>
  children: FakeSearchElement[]
  listeners: Record<string, Listener[]>
  getAttribute(name: string): string | null
  addEventListener(type: string, fn: Listener): void
  fire(type: string, event?: Record<string, unknown>): void
  appendChild(node: FakeSearchElement): void
  replaceChildren(): void
}

interface FakeSearchRoot extends FakeSearchElement {
  querySelector(selector: string): FakeSearchElement | null
}

function searchElement(attrs: Record<string, string> = {}): FakeSearchElement {
  const self: FakeSearchElement = {
    hidden: false,
    value: '',
    textContent: '',
    className: '',
    href: '',
    children: [],
    listeners: {},
    getAttribute: (name) => attrs[name] ?? null,
    addEventListener: (type, fn) => (self.listeners[type] ??= []).push(fn),
    fire: (type, event = {}) => (self.listeners[type] ?? []).forEach((fn) => fn(event)),
    appendChild: (node) => void self.children.push(node),
    replaceChildren: () => { self.children = [] },
  }
  return self
}

function searchRoot(): FakeSearchRoot {
  const form = searchElement()
  const query = searchElement()
  const version = searchElement()
  version.value = 'current'
  version.options = [{ value: 'current' }, { value: 'v0.6.0' }, { value: 'all' }]
  const status = searchElement()
  const results = searchElement()
  const attrs: Record<string, string> = {
    'data-search-index': '/docs-search.json',
    'data-lang': 'en',
    'data-empty': 'Enter a search.',
    'data-no-results': 'No match.',
    'data-error': 'Search unavailable.',
    'data-count-one': '{count} result',
    'data-count-many': '{count} results',
    'data-english-source': 'English snapshot',
  }
  const root = searchElement(attrs) as FakeSearchRoot
  root.hidden = true
  root.querySelector = (selector) => ({
    form,
    'input[type="search"]': query,
    'select[name="version"]': version,
    '[data-search-status]': status,
    '[data-search-results]': results,
  } as Record<string, FakeSearchElement>)[selector] ?? null
  return Object.assign(root, { form, query, version, status, results }) as FakeSearchRoot
}

function changelogRoot(): FakeSearchRoot {
  const root = searchElement({
    'data-no-results': 'No matching releases.',
    'data-page-template': 'Page {page} of {pages} · {count} releases',
    'data-result-template': '{count} releases',
  }) as FakeSearchRoot
  const controls: Record<string, FakeSearchElement> = {
    form: searchElement(),
    'input[type="search"]': searchElement(),
    'select[name="version"]': searchElement(),
    'select[name="type"]': searchElement(),
    '[data-changelog-status]': searchElement(),
    '[data-page-status]': searchElement(),
    '[data-page-previous]': searchElement(),
    '[data-page-next]': searchElement(),
  }
  const version = controls['select[name="version"]']
  const category = controls['select[name="type"]']
  if (!version || !category) throw new Error('test control fixtures are incomplete')
  version.value = 'all'
  version.options = [{ value: 'all' }, { value: 'v0.6.0' }, { value: 'v0.5.0' }, { value: 'v0.4.0' }, { value: 'v0.3.0' }]
  category.value = 'all'
  category.options = [{ value: 'all' }, { value: 'new' }, { value: 'fixed' }, { value: 'removed' }]
  root.hidden = true
  root.querySelector = (selector) => controls[selector] ?? null
  return Object.assign(root, { controls }) as FakeSearchRoot
}

function release(tag: string, id: string, categories: string, text: string): FakeSearchElement {
  return Object.assign(searchElement({ 'data-version': tag, 'data-categories': categories, 'data-search': text }), { id })
}

function diagramTarget(detail: string): FakeDiagramTarget {
  const self: FakeDiagramTarget = {
    inside: true,
    getAttribute: (name) => name === 'data-diagram-detail' ? detail : null,
    closest: (selector) => selector === '[data-diagram-part]' ? self : null,
  }
  return self
}

function explorer(defaultDetail: string): FakeExplorer {
  const output = {
    textContent: defaultDetail,
    getAttribute: (name: string) => name === 'data-default' ? defaultDetail : null,
  }
  const self: FakeExplorer = {
    output,
    listeners: {},
    addEventListener: (type, fn) => (self.listeners[type] ??= []).push(fn),
    querySelector: (selector) => selector === '[data-diagram-description]' ? output : null,
    contains: (node) => node === self || Boolean(node && typeof node === 'object' && 'inside' in node && node.inside === true),
    fire: (type, event) => (self.listeners[type] ?? []).forEach((listener) => listener(event)),
  }
  return self
}

function clip(rejectPlay = false, opts: { videoApi?: boolean; customControl?: boolean } = {}): FakeClip {
  const listeners: Listener[] = []
  const toggle: FakeToggle = {
    hidden: true,
    textContent: 'Pause the demo',
    getAttribute: (n) => ({ 'data-play': 'Play the demo', 'data-pause': 'Pause the demo' })[n] ?? null,
    addEventListener: (_t, fn) => void listeners.push(fn),
    click: () => listeners.forEach((fn) => fn()),
  }
  const self: FakeClip = {
    paused: true,
    controls: true,
    plays: 0,
    pauses: 0,
    nextElementSibling: opts.customControl === false ? null : toggle,
  }
  if (opts.videoApi !== false) {
    self.play = () => {
      self.plays++
      if (rejectPlay) return Promise.reject(Object.assign(new Error('refused'), { name: 'NotAllowedError' }))
      self.paused = false
      return Promise.resolve()
    }
    self.pause = () => {
      self.pauses++
      self.paused = true
    }
  }
  return self
}

function boot(opts: {
  buttons?: FakeButton[]
  clips?: FakeClip[]
  explorers?: FakeExplorer[]
  searches?: FakeSearchRoot[]
  searchData?: unknown
  searchFailure?: boolean
  changelog?: FakeSearchRoot
  releaseSections?: FakeSearchElement[]
  releaseLinks?: FakeSearchElement[]
  startUrl?: string
  clipboard?: { writeText(text: string): Promise<void> } | null
  reduce?: boolean | null
}) {
  const timers: Array<() => void> = []
  const mediaListeners: Listener[] = []
  const media = { matches: opts.reduce === true, addEventListener: (_t: string, fn: Listener) => void mediaListeners.push(fn) }
  const location = { href: opts.startUrl ?? (opts.changelog ? 'https://site.test/changelog/' : 'https://site.test/docs/?q=old&version=v0.6.0'), origin: 'https://site.test' }
  const historyCalls: Array<{ mode: string; href: string }> = []
  const windowListeners: Record<string, Listener[]> = {}
  let observerCallback: (entries: Array<{ isIntersecting: boolean }>) => void = () => undefined
  class Observer {
    constructor(cb: typeof observerCallback) {
      observerCallback = cb
    }
    observe(): void {}
    unobserve(): void {}
  }
  const win: Record<string, unknown> = {
    innerHeight: 800,
    IntersectionObserver: Observer,
    setTimeout: (fn: () => void) => void timers.push(fn),
    URL,
    location,
    history: {
      pushState: (_state: unknown, _title: string, href: URL) => { location.href = String(href); historyCalls.push({ mode: 'push', href: String(href) }) },
      replaceState: (_state: unknown, _title: string, href: URL) => { location.href = String(href); historyCalls.push({ mode: 'replace', href: String(href) }) },
    },
    addEventListener: (type: string, fn: Listener) => (windowListeners[type] ??= []).push(fn),
    fetch: (_url: string, _init: unknown) => opts.searchFailure
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ ok: true, json: async () => opts.searchData ?? [] }),
    navigator: opts.clipboard === null ? {} : { clipboard: opts.clipboard ?? { writeText: async () => undefined } },
    matchMedia: opts.reduce === null ? undefined : () => media,
  }
  const doc = {
    documentElement: { dataset: {} as Record<string, string> },
    querySelectorAll: (selector: string) => {
      if (selector === 'button.copy[data-copy]') return opts.buttons ?? []
      if (selector === 'video[data-motion]') return opts.clips ?? []
      if (selector === '[data-diagram-explorer]') return opts.explorers ?? []
      if (selector === '[data-docs-search]') return opts.searches ?? []
      if (selector === '[data-changelog]') return opts.changelog ? [opts.changelog] : []
      if (selector === '[data-release]') return opts.releaseSections ?? []
      if (selector === '.changelog__index a[href^="#"]') return opts.releaseLinks ?? []
      return []
    },
    createElement: (tagName: string) => Object.assign(searchElement(), { tagName }),
    getElementById: (id: string) => (opts.releaseSections ?? []).find((section) => section.id === id) ?? null,
  }
  new Function('window', 'document', script)(win, doc)
  return {
    timers,
    media,
    mediaListeners,
    historyCalls,
    windowListeners,
    location,
    setReduce: (v: boolean) => { media.matches = v; mediaListeners.forEach((fn) => fn()) },
    intersect: (isIntersecting: boolean) => observerCallback([{ isIntersecting }]),
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the copy button', () => {
  test('appears only where the clipboard can be written, and does nothing without it', () => {
    const a = button({ 'data-copy': 'x' })
    boot({ buttons: [a], clipboard: null })
    expect(a.hidden).toBe(true)
    const b = button({ 'data-copy': 'x' })
    boot({ buttons: [b] })
    expect(b.hidden).toBe(false)
  })

  test('copies the line, says so, and gives the label back', async () => {
    const written: string[] = []
    const b = button({ 'data-copy': 'curl -fsSL https://example.org | sh', 'data-copied': 'Copied', 'data-failed': 'Could not copy' })
    const { timers } = boot({ buttons: [b], clipboard: { writeText: async (t) => void written.push(t) } })
    b.click()
    await flush()
    expect(written).toEqual(['curl -fsSL https://example.org | sh'])
    expect(b.textContent).toBe('Copied')
    expect(b.nextElementSibling.textContent).toBe('Copied')
    timers.forEach((fn) => fn())
    expect(b.textContent).toBe('Copy')
  })

  test('a refusal is announced, and the label does not lie', async () => {
    const b = button({ 'data-copy': 'x', 'data-copied': 'Copied', 'data-failed': 'Could not copy' })
    boot({ buttons: [b], clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
    b.click()
    await flush()
    expect(b.nextElementSibling.textContent).toBe('Could not copy')
    expect(b.textContent).toBe('Copy')
  })
})

describe('Docs search', () => {
  test('loads the local index, restores URL state, renders safe results and follows filter state', async () => {
    const root = searchRoot()
    const { historyCalls, location } = boot({
      searches: [root],
      searchData: [
        { lang: 'en', version: 'current', title: 'Configuration', section: 'Named ports', href: '/docs/configuration/#named-ports', text: 'Reserve a port for each session.' },
        { lang: 'en', version: 'v0.6.0', title: '<img src=x>', section: 'Old worktrees', href: '/docs/versions/v0.6.0/#worktrees', text: 'A repository can have isolated worktrees.' },
      ],
    })
    await flush()
    expect(root.hidden).toBe(false)
    expect(root.querySelector('input[type="search"]')?.value).toBe('old')
    expect(root.querySelector('select[name="version"]')?.value).toBe('v0.6.0')
    const query = root.querySelector('input[type="search"]')
    const version = root.querySelector('select[name="version"]')
    expect(root.querySelector('[data-search-status]')?.textContent).toBe('1 result')
    if (!query || !version) throw new Error('search controls are missing')
    query.value = 'isolated worktrees'
    query.fire('input')
    expect(root.querySelector('[data-search-status]')?.textContent).toBe('1 result')
    const item = root.querySelector('[data-search-results]')?.children[0]
    expect(item?.children[0]?.href).toBe('/docs/versions/v0.6.0/#worktrees')
    expect(item?.children[0]?.textContent).toBe('Old worktrees')
    expect(item?.children[0]?.textContent).not.toContain('<img')
    expect(historyCalls.at(-1)?.mode).toBe('replace')
    expect(new URL(location.href).searchParams.get('q')).toBe('isolated worktrees')
    version.value = 'current'
    version.fire('change')
    expect(root.querySelector('[data-search-status]')?.textContent).toBe('No match.')
    root.querySelector('form')?.fire('submit', { preventDefault: () => undefined })
    expect(historyCalls.at(-1)?.mode).toBe('push')
  })

  test('shows a localized failure without changing the static documentation', async () => {
    const root = searchRoot()
    const { } = boot({ searches: [root], searchFailure: true })
    await flush()
    expect(root.hidden).toBe(false)
    expect(root.querySelector('form')?.hidden).toBe(true)
    expect(root.querySelector('[data-search-status]')?.textContent).toBe('Search unavailable.')
  })
})

describe('Changelog explorer', () => {
  test('pages releases, restores query state, and moves to an anchored release', () => {
    const root = changelogRoot()
    const sections = [
      release('v0.6.0', 'v0-6-0', 'new fixed', 'parallel sessions and worktrees'),
      release('v0.5.0', 'v0-5-0', 'new', 'cockpit settings'),
      release('v0.4.0', 'v0-4-0', 'removed', 'remote control'),
      release('v0.3.0', 'v0-3-0', 'fixed', 'lease reliability'),
    ]
    const lastLink = searchElement({ href: '#v0-3-0' })
    const { historyCalls, location, windowListeners } = boot({ changelog: root, releaseSections: sections, releaseLinks: [lastLink], startUrl: 'https://site.test/changelog/#v0-3-0' })
    const [controls] = [root.querySelector('form'), root.querySelector('input[type="search"]'), root.querySelector('select[name="version"]'), root.querySelector('select[name="type"]')]
    expect(root.hidden).toBe(false)
    expect(sections.map((section) => section.hidden)).toEqual([true, true, true, false])
    expect(root.querySelector('[data-page-status]')?.textContent).toBe('Page 2 of 2 · 4 releases')
    lastLink.fire('click', { preventDefault: () => undefined })
    expect(location.href).toContain('#v0-3-0')
    expect(historyCalls.at(-1)?.mode).toBe('push')
    root.querySelector('[data-page-previous]')?.fire('click')
    expect(sections.map((section) => section.hidden)).toEqual([false, false, false, true])
    const next = root.querySelector('[data-page-next]')
    next?.fire('click')
    expect(sections.map((section) => section.hidden)).toEqual([true, true, true, false])

    const query = root.querySelector('input[type="search"]')
    const version = root.querySelector('select[name="version"]')
    const category = root.querySelector('select[name="type"]')
    if (!query || !version || !category || !controls) throw new Error('changelog controls are missing')
    query.value = 'parallel worktrees'
    category.value = 'new'
    category.fire('change')
    expect(sections.map((section) => section.hidden)).toEqual([false, true, true, true])
    expect(root.querySelector('[data-page-status]')?.textContent).toBe('Page 1 of 1 · 1 releases')
    query.value = 'nothing matches'
    query.fire('input')
    expect(root.querySelector('[data-changelog-status]')?.textContent).toBe('No matching releases.')

    location.href = historyCalls.filter((call) => call.href.includes('page=2')).at(-1)?.href ?? 'https://site.test/changelog/?page=2'
    windowListeners.popstate?.forEach((listener) => listener({}))
    expect(root.querySelector('[data-page-status]')?.textContent).toBe('Page 2 of 2 · 4 releases')
  })
})

describe('the demo clip', () => {
  test('where motion is welcome it plays and the Pause button is there', () => {
    const c = clip()
    boot({ clips: [c] })
    expect(c.controls).toBe(false)
    expect(c.nextElementSibling?.hidden).toBe(false)
    expect(c.plays).toBe(1)
    expect(c.nextElementSibling?.textContent).toBe('Pause the demo')
  })

  test('with reduced motion it never plays, and the button says Play', () => {
    const c = clip()
    boot({ clips: [c], reduce: true })
    expect(c.plays).toBe(0)
    expect(c.paused).toBe(true)
    expect(c.nextElementSibling?.hidden).toBe(false)
    expect(c.nextElementSibling?.textContent).toBe('Play the demo')
    c.nextElementSibling?.click()
    expect(c.plays).toBe(1)
    expect(c.paused).toBe(false)
  })

  test('without matchMedia it keeps native controls and never autoplays', () => {
    const c = clip()
    boot({ clips: [c], reduce: null })
    expect(c.plays).toBe(0)
    expect(c.controls).toBe(true)
    expect(c.nextElementSibling?.hidden).toBe(true)
  })

  test('without the video API it keeps native controls and does not initialize the toggle', () => {
    const c = clip(false, { videoApi: false })
    boot({ clips: [c] })
    expect(c.plays).toBe(0)
    expect(c.controls).toBe(true)
    expect(c.nextElementSibling?.hidden).toBe(true)
  })

  test('without the custom control it keeps native controls and does not autoplay', () => {
    const c = clip(false, { customControl: false })
    boot({ clips: [c] })
    expect(c.plays).toBe(0)
    expect(c.controls).toBe(true)
  })

  test('a change of the preference while the page is open is followed', () => {
    const c = clip()
    const { setReduce } = boot({ clips: [c] })
    setReduce(true)
    expect(c.pauses).toBeGreaterThan(0)
    setReduce(false)
    expect(c.plays).toBeGreaterThanOrEqual(2)
  })

  test('the button pauses and plays, and a pause by the reader survives scrolling away and back', () => {
    const c = clip()
    const { intersect } = boot({ clips: [c] })
    c.nextElementSibling?.click()
    expect(c.paused).toBe(true)
    expect(c.nextElementSibling?.textContent).toBe('Play the demo')
    const plays = c.plays
    intersect(false)
    intersect(true)
    expect(c.plays).toBe(plays)
    c.nextElementSibling?.click()
    expect(c.paused).toBe(false)
  })

  test('it pauses when scrolled out of view and resumes when it returns', () => {
    const c = clip()
    const { intersect } = boot({ clips: [c] })
    intersect(false)
    expect(c.paused).toBe(true)
    intersect(true)
    expect(c.paused).toBe(false)
  })

  test('a browser that refuses to start it leaves a button that says Play', async () => {
    const c = clip(true)
    boot({ clips: [c] })
    await flush()
    expect(c.nextElementSibling?.hidden).toBe(false)
    expect(c.nextElementSibling?.textContent).toBe('Play the demo')
  })
})

describe('the workflow diagram explainer', () => {
  test('hover updates detail and leaving the explorer restores its overview', () => {
    const region = explorer('overview')
    const target = diagramTarget('api session details')
    boot({ explorers: [region] })
    region.fire('pointerover', { target, pointerType: 'mouse' })
    expect(region.output.textContent).toBe('api session details')
    region.fire('pointerout', { target, relatedTarget: { inside: false }, pointerType: 'mouse' })
    expect(region.output.textContent).toBe('overview')
  })

  test('keyboard focus and Enter or Space keep the focused detail available', () => {
    const region = explorer('overview')
    const target = diagramTarget('trial merge details')
    boot({ explorers: [region] })
    region.fire('focusin', { target })
    expect(region.output.textContent).toBe('trial merge details')
    let prevented = false
    region.fire('keydown', { target, key: ' ', preventDefault: () => { prevented = true } })
    expect(prevented).toBe(true)
    expect(region.output.textContent).toBe('trial merge details')
  })

  test('touch selection keeps its detail after the synthetic pointer leaves', () => {
    const region = explorer('overview')
    const target = diagramTarget('land route details')
    boot({ explorers: [region] })
    region.fire('click', { target })
    region.fire('pointerout', { target, relatedTarget: { inside: false }, pointerType: 'touch' })
    expect(region.output.textContent).toBe('land route details')
  })
})
