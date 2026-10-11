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

function boot(opts: { buttons?: FakeButton[]; clips?: FakeClip[]; clipboard?: { writeText(text: string): Promise<void> } | null; reduce?: boolean | null }) {
  const timers: Array<() => void> = []
  const mediaListeners: Listener[] = []
  const media = { matches: opts.reduce === true, addEventListener: (_t: string, fn: Listener) => void mediaListeners.push(fn) }
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
    navigator: opts.clipboard === null ? {} : { clipboard: opts.clipboard ?? { writeText: async () => undefined } },
    matchMedia: opts.reduce === null ? undefined : () => media,
  }
  const doc = {
    documentElement: { dataset: {} as Record<string, string> },
    querySelectorAll: (selector: string) => {
      if (selector === 'button.copy[data-copy]') return opts.buttons ?? []
      if (selector === 'video[data-motion]') return opts.clips ?? []
      return []
    },
  }
  new Function('window', 'document', script)(win, doc)
  return { timers, media, mediaListeners, setReduce: (v: boolean) => { media.matches = v; mediaListeners.forEach((fn) => fn()) }, intersect: (isIntersecting: boolean) => observerCallback([{ isIntersecting }]) }
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
