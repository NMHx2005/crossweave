/**
 * Guards for the design system. Two jobs:
 *
 *  1. Drift: the stylesheet may only reference tokens that exist, must not carry a
 *     literal colour of its own, and the pre-paint value in index.html must equal
 *     the surface token. This is the failure mode the token layer was introduced to
 *     remove — the xterm pane used to hold its own copy of the palette.
 *  2. Legibility: every text-on-background pair the UI actually paints is measured
 *     against WCAG AA here, so a "prettier" value cannot quietly ship illegible.
 */
import { describe, expect, it, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BADGE_FILL, BADGE_WASH, COCKPIT_TOKENS, XTERM_THEME } from '../src/ui/tokens'
import { DARK_COLORS, LIGHT_COLORS, deriveColors, resolveTheme } from '../src/ui/themes'
import type { TerminalColors } from '../../../src/core/settings.js'

const cockpitRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(`${cockpitRoot}${rel}`, 'utf8')
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
const css = stripComments(read('src/ui/app.css'))
const html = read('index.html')
const T = COCKPIT_TOKENS

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6)
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** The same arithmetic `color-mix(in srgb, a weightA, b)` performs. */
function mix(a: string, b: string, weightA: number): string {
  const ca = channels(a)
  const cb = channels(b)
  const body = ca
    .map((v, i) => Math.round(v * weightA + (cb[i] as number) * (1 - weightA)).toString(16).padStart(2, '0'))
    .join('')
  return `#${body}`
}

const AA_NORMAL = 4.5

describe('cockpit design tokens — drift', () => {
  const used = [...new Set([...css.matchAll(/var\((--cw-[a-z0-9-]+)\)/g)].map((m) => m[1] as string))]
  const defined = new Set(Object.keys(COCKPIT_TOKENS))

  it('every var() the stylesheet uses is backed by a token', () => {
    expect(used.filter((name) => !defined.has(name))).toEqual([])
  })

  it('the stylesheet really is tokenised (guard against a vacuous pass)', () => {
    expect(used.length).toBeGreaterThan(30)
  })

  it('carries no dimensional literal except the three structural ones', () => {
    // 100% and 100vh size the shell to the window; 0.01ms is what the reduced-motion
    // override collapses every duration to. Everything else that has a unit is a
    // design decision and belongs in tokens.ts — this is the check that would have
    // caught the hand-written `border-radius: 5px` sitting next to --cw-radius.
    const allowed = new Set(['100%', '100vh', '0.01ms'])
    const literals = [...css.matchAll(/(?<![\w-])\d+(?:\.\d+)?(?:px|rem|em|ms|s|vh|vw)/g)].map((m) => m[0])
    expect(literals.filter((value) => !allowed.has(value))).toEqual([])
  })

  it('carries no literal colour or colour function of its own', () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(css.match(/\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([])
  })

  it('the pre-paint frame in index.html equals --cw-surface', () => {
    expect(html.match(/background:\s*(#[0-9a-fA-F]{6})/)?.[1]?.toLowerCase()).toBe(T['--cw-surface'])
  })

  it('the pane shares the chrome palette instead of copying it', () => {
    expect(XTERM_THEME.background).toBe(T['--cw-surface'])
    expect(XTERM_THEME.foreground).toBe(T['--cw-text'])
    expect(XTERM_THEME.cursor).toBe(T['--cw-cursor'])
    expect(XTERM_THEME.selectionBackground).toBe(T['--cw-selection'])
  })

  it('keeps the terminal palette standard rather than reusing badge hues', () => {
    // If these ever converge, an agent's TUI starts printing badge colours.
    expect(XTERM_THEME.blue).not.toBe(T['--cw-working'])
    expect(XTERM_THEME.green).not.toBe(T['--cw-ready'])
    expect(XTERM_THEME.red).not.toBe(T['--cw-blocked'])
  })

  it('the stylesheet uses the same mix weights the contrast test measures', () => {
    const wash = `${Math.round(BADGE_WASH * 100)}%`
    const fill = `${Math.round(BADGE_FILL * 100)}%`
    for (const token of ['--cw-working', '--cw-ready', '--cw-needs-you']) {
      expect(css).toContain(`var(${token}) ${wash}`)
    }
    for (const token of ['--cw-blocked', '--cw-conflict']) {
      expect(css).toContain(`var(${token}) ${fill}`)
    }
  })
})

/**
 * The same WCAG checks for every theme: Dark (the tokens), Light, and the theme derived
 * from a terminal's colors — for several real palettes, including a deliberately
 * low-contrast one that only passes because the derivation nudges it.
 */
function legibility(T: Record<string, string>): void {
  test('body, bright and dim text on their own surfaces', () => {
    expect(contrast(T['--cw-text'], T['--cw-surface'])).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(T['--cw-text-bright'], T['--cw-surface-active'])).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(T['--cw-text-dim'], T['--cw-surface'])).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(T['--cw-text-dim'], T['--cw-surface-badge'])).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  test('the recent-activity rows and their badges', () => {
    // Text on a hovered row, the "View all" link, and the unread count on its badge —
    // the three pairs the activity section paints that nothing else does.
    expect(contrast(T['--cw-text'], T['--cw-surface-hover'])).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(T['--cw-accent'], T['--cw-surface'])).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(T['--cw-text-bright'], T['--cw-surface-badge'])).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  test('button labels on the control surface', () => {
    expect(contrast(T['--cw-text-bright'], T['--cw-surface-control'])).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  test('the control layer: buttons in every state, fields, and what floats', () => {
    expect(contrast(T['--cw-text-bright'], T['--cw-surface-control-hover'])).toBeGreaterThanOrEqual(AA_NORMAL)
    // Primary and danger buttons carry dark text on the hue, resting and hovered.
    for (const bg of ['--cw-accent', '--cw-accent-hover', '--cw-blocked', '--cw-danger-hover'] as const) {
      expect(contrast(T['--cw-surface'], T[bg])).toBeGreaterThanOrEqual(AA_NORMAL)
    }
    expect(contrast(T['--cw-text-bright'], T['--cw-surface-input'])).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(T['--cw-text-dim'], T['--cw-surface-input'])).toBeGreaterThanOrEqual(AA_NORMAL)
    // Menus and dialogs: body, dim and danger text on the overlay, and a hovered item.
    for (const fg of ['--cw-text', '--cw-text-dim', '--cw-text-bright', '--cw-blocked'] as const) {
      expect(contrast(T[fg], T['--cw-surface-overlay'])).toBeGreaterThanOrEqual(AA_NORMAL)
    }
    expect(contrast(T['--cw-text-bright'], T['--cw-surface-active'])).toBeGreaterThanOrEqual(AA_NORMAL)
    // The font picker marks the font in use in the accent, on the list and on a hovered row.
    expect(contrast(T['--cw-accent'], T['--cw-surface-overlay'])).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(T['--cw-accent'], T['--cw-surface-active'])).toBeGreaterThanOrEqual(AA_NORMAL)
    // The rail's finished mark and its usage figures.
    expect(contrast(T['--cw-ready'], T['--cw-surface-sidebar'])).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(T['--cw-text-dim'], T['--cw-surface-sidebar'])).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(T['--cw-text-dim'], T['--cw-surface-active'])).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  test('disabled labels stay readable on the control surface', () => {
    // WCAG exempts disabled controls, and this system used that exemption to go down
    // to ~1.15:1 — which is not "quiet", it is invisible (see the design-system
    // spec's accessibility section). A quieter-than-AA floor is deliberate here; an
    // unreadable one is not.
    expect(contrast(T['--cw-text-dim'], T['--cw-surface-control'])).toBeGreaterThanOrEqual(3)
  })

  test('washed badges: hue text on a wash of itself', () => {
    for (const token of ['--cw-working', '--cw-ready', '--cw-needs-you'] as const) {
      const bg = mix(T[token], T['--cw-surface-badge'], BADGE_WASH)
      expect(contrast(T[token], bg)).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  test('filled badges: dark text on the hue', () => {
    for (const token of ['--cw-blocked', '--cw-conflict'] as const) {
      const bg = mix(T[token], T['--cw-surface'], BADGE_FILL)
      expect(contrast(T['--cw-surface'], bg)).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })
  test('a clashing shortcut and a hovered danger item stay readable', () => {
    expect(contrast(T['--cw-blocked'], T['--cw-surface-hover'])).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(T['--cw-blocked'], T['--cw-surface-active'])).toBeGreaterThanOrEqual(AA_NORMAL)
  })
}

const PALETTES: Record<string, TerminalColors> = {
  'Catppuccin Mocha': {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selection: '#585b70',
    ansi: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8', '#585b70', '#f37799', '#89d88b', '#ebd391', '#74a8fc', '#f2aede', '#6bd7ca', '#bac2de'],
  },
  'Solarized Light': {
    background: '#fdf6e3', foreground: '#657b83',
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'],
  },
  'Gruvbox Dark': {
    background: '#282828', foreground: '#ebdbb2',
    ansi: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
  },
  'low contrast, no palette': { background: '#3a3a3a', foreground: '#6a6a6a' },
}

describe('cockpit design tokens — legibility (WCAG AA), Dark', () => legibility(DARK_COLORS))
describe('cockpit design tokens — legibility (WCAG AA), Light', () => legibility(LIGHT_COLORS))
for (const [name, palette] of Object.entries(PALETTES)) {
  describe(`cockpit design tokens — legibility (WCAG AA), from terminal: ${name}`, () => legibility(deriveColors(palette)))
}

describe('themes', () => {
  test('every theme defines every color token', () => {
    const names = Object.keys(DARK_COLORS).sort()
    expect(Object.keys(LIGHT_COLORS).sort()).toEqual(names)
    expect(Object.keys(deriveColors(PALETTES['Gruvbox Dark']!)).sort()).toEqual(names)
  })

  test('system follows macOS; terminal needs imported colors, else follows the system', () => {
    expect(resolveTheme('system', undefined, true).name).toBe('dark')
    expect(resolveTheme('system', undefined, false).name).toBe('light')
    expect(resolveTheme(undefined, undefined, false).name).toBe('light')
    expect(resolveTheme('dark', undefined, false).name).toBe('dark')
    expect(resolveTheme('terminal', undefined, true).name).toBe('dark')
    const t = resolveTheme('terminal', PALETTES['Solarized Light'], true)
    expect([t.name, t.scheme, t.colors['--cw-surface']]).toEqual(['terminal', 'light', '#fdf6e3'])
  })
})
