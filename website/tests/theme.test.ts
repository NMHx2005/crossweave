import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { THEME_NAMES, THEME_PAIRS, themeCss } from '../src/theme'

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function luminance(hex: string): number {
  const h = hex.replace('#', '').slice(0, 6)
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe('the theme', () => {
  const out = themeCss()

  test('dark is the default and light follows the system, from the cockpit\'s own token modules', () => {
    expect(out).toContain(':root{color-scheme:dark light;')
    expect(out).toContain('@media (prefers-color-scheme: light){:root{')
    expect(out).toContain(`--cw-surface:${THEME_NAMES.dark['--cw-surface']}`)
    expect(out).toContain(`--cw-surface:${THEME_NAMES.light['--cw-surface']}`)
  })

  test('light defines every colour dark does, so no pair loses a value in one scheme', () => {
    expect(Object.keys(THEME_NAMES.light).sort()).toEqual(Object.keys(THEME_NAMES.dark).sort())
  })

  test('the output is deterministic', () => {
    expect(themeCss()).toBe(out)
  })
})

describe('the stylesheet', () => {
  const body = stripComments(css)

  test('has no colour literal of its own, no px, no import and no remote url', () => {
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(body).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/)
    expect(body).not.toMatch(/\d\s*px\b/)
    expect(body).not.toContain('@import')
    expect(body).not.toMatch(/url\(\s*["']?(https?:)?\/\//)
  })

  test('every var() it uses is defined by the theme or by the stylesheet itself', () => {
    const theme = themeCss()
    const own = new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    const used = new Set([...body.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
    const orphans = [...used].filter((name) => !own.has(name as string) && !theme.includes(`${name}:`))
    expect(orphans).toEqual([])
  })

  test('honours reduced motion', () => {
    expect(body).toContain('prefers-reduced-motion: reduce')
  })
})

describe('contrast (WCAG AA, 4.5:1) of every text/background pair the stylesheet paints', () => {
  for (const scheme of ['dark', 'light'] as const) {
    test(scheme, () => {
      const colors = THEME_NAMES[scheme]
      const failures: string[] = []
      for (const { fg, bg, where } of THEME_PAIRS) {
        const a = colors[fg]
        const b = colors[bg]
        if (a === undefined || b === undefined) {
          failures.push(`${where}: ${fg} or ${bg} is not defined`)
          continue
        }
        const ratio = contrast(a, b)
        if (ratio < 4.5) failures.push(`${where}: ${fg} on ${bg} is ${ratio.toFixed(2)}`)
      }
      expect(failures).toEqual([])
    })
  }

  test('every pair names tokens the stylesheet really uses', () => {
    const body = stripComments(css)
    for (const { fg, bg } of THEME_PAIRS) {
      expect(body, fg).toContain(`var(${fg})`)
      expect(body, bg).toContain(`var(${bg})`)
    }
  })
})
