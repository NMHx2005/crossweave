import type { TerminalColors } from '../../../../src/core/settings.js'
import { contrast, ensureContrast, isDark, mix } from '../lib/color'
import { BADGE_FILL, BADGE_WASH, COCKPIT_TOKENS, XTERM_THEME } from './tokens'

/**
 * The window's color themes. A theme is a full set of the color tokens — never a
 * partial override — so every pair the stylesheet paints has a value in every theme,
 * and `tests/tokens.test.ts` runs the same WCAG checks over each of them.
 *
 * - dark: the tokens as they have always been (One Dark Pro Night Flat).
 * - light: the same roles from the One Light family, measured the same way.
 * - terminal: derived from the colors imported from Ghostty / iTerm2 (Settings →
 *   Terminal), each role nudged toward legibility until its pairs pass AA.
 */

type TokenName = keyof typeof COCKPIT_TOKENS
const COLOR_NAMES = (Object.keys(COCKPIT_TOKENS) as TokenName[]).filter((n) => COCKPIT_TOKENS[n].startsWith('#'))
export type ColorTokens = Record<string, string>

export const DARK_COLORS: ColorTokens = Object.fromEntries(COLOR_NAMES.map((n) => [n, COCKPIT_TOKENS[n]]))

export const LIGHT_COLORS: ColorTokens = {
  '--cw-surface': '#fafafa',
  '--cw-surface-input': '#ffffff',
  '--cw-surface-hover': '#ececed',
  '--cw-surface-active': '#e0e0e2',
  '--cw-surface-control': '#e4e4e6',
  '--cw-surface-control-hover': '#d8d8db',
  '--cw-surface-overlay': '#ffffff',
  '--cw-shadow': '#00000033',
  '--cw-scrim': '#00000026',
  '--cw-surface-badge': '#f0f0f1',
  '--cw-surface-sidebar': '#f1f1f2',
  '--cw-border': '#d6d6d9',
  '--cw-border-strong': '#c4c4c8',
  '--cw-border-hover': '#a0a1a7',
  '--cw-text': '#383a42',
  '--cw-text-bright': '#1f2126',
  '--cw-text-dim': '#5b5e68',
  '--cw-accent': '#0b5fc4',
  '--cw-accent-hover': '#0a53ac',
  '--cw-danger-hover': '#a61c2d',
  '--cw-cursor': '#526fff',
  '--cw-selection': '#bcd0f760',
  '--cw-working': '#055a8f',
  '--cw-ready': '#28600f',
  '--cw-needs-you': '#8a4f00',
  '--cw-blocked': '#bd2336',
  '--cw-conflict': '#8f25a8',
  '--cw-agent-claude': '#c15f3c',
  '--cw-agent-codex': '#383a42',
  '--cw-agent-gemini': '#2f63cf',
  '--cw-agent-opencode': '#5b5e68',
  '--cw-agent-antigravity': '#3a5bd0',
  '--cw-agent-cursor': '#383a42',
  '--cw-agent-copilot': '#7447c9',
  '--cw-agent-aider': '#1d7f50',
  '--cw-agent-amp': '#a85a08',
  '--cw-agent-qwen': '#4450cc',
  '--cw-scrollbar': '#c4c4c8',
  '--cw-scrollbar-hover': '#a0a1a7',
  '--cw-qr-dark': '#000000',
  '--cw-qr-light': '#ffffff',
}

/** `color`, moved away from `away` until `ok` holds (a pair whose background depends on it). */
function nudge(color: string, away: string, ok: (c: string) => boolean): string {
  if (ok(color)) return color
  const target = isDark(away) ? '#ffffff' : '#000000'
  for (let step = 1; step <= 20; step++) {
    const next = mix(target, color, step / 20)
    if (ok(next)) return next
  }
  return target
}

/** The lightest (on dark) or darkest (on light) of `surfaces`: the hardest to read on. */
function hardest(surfaces: string[], dark: boolean): string {
  return [...surfaces].sort((a, b) => contrast(b, dark ? '#000000' : '#ffffff') - contrast(a, dark ? '#000000' : '#ffffff'))[0] as string
}

/**
 * A whole theme from a terminal's colors: surfaces are the background moved toward
 * the foreground in small steps, text is the foreground, and the attention roles and
 * the accent come from the terminal's own bright ANSI colors — each checked, and
 * nudged, against every surface it is drawn on.
 */
export function deriveColors(t: TerminalColors): ColorTokens {
  const bg = t.background
  const fg = t.foreground
  const dark = isDark(bg)
  const base = dark ? DARK_COLORS : LIGHT_COLORS
  const step = (w: number): string => mix(fg, bg, w)
  const ansi = (i: number, fallback: string): string => t.ansi?.[i] ?? fallback

  const surfaces = {
    '--cw-surface': bg,
    '--cw-surface-sidebar': step(0.035),
    '--cw-surface-input': step(0.03),
    '--cw-surface-overlay': step(0.06),
    '--cw-surface-badge': step(0.07),
    '--cw-surface-hover': step(0.1),
    '--cw-surface-active': step(0.15),
    '--cw-surface-control': step(0.22),
    '--cw-surface-control-hover': step(0.28),
  }
  const readOn = Object.values(surfaces).filter((s) => s !== surfaces['--cw-surface-control'] && s !== surfaces['--cw-surface-control-hover'])
  const worst = hardest(readOn, dark)
  const text = ensureContrast(step(0.88), worst, 4.5)
  const textBright = ensureContrast(fg, hardest([...readOn, surfaces['--cw-surface-control-hover']], dark), 4.5)
  const textDim = ensureContrast(step(0.7), worst, 4.5)
  const accent = ensureContrast(ansi(12, base['--cw-accent'] as string), worst, 4.5)
  // Primary buttons: the surface color as text on the accent, resting and hovered.
  const accentHover = nudge(mix(accent, fg, 0.85), bg, (c) => contrast(bg, c) >= 4.5 && contrast(c, worst) >= 3)
  const badge = surfaces['--cw-surface-badge']
  const washed = (hue: string): string => nudge(hue, badge, (c) => contrast(c, mix(c, badge, BADGE_WASH)) >= 4.5
    && contrast(c, surfaces['--cw-surface-sidebar']) >= 4.5 && contrast(c, surfaces['--cw-surface-overlay']) >= 4.5)
  // Filled badges carry the surface color as text on 85% of the hue.
  const filled = (hue: string): string => nudge(hue, bg, (c) => contrast(bg, mix(c, bg, BADGE_FILL)) >= 4.5
    && contrast(c, surfaces['--cw-surface-overlay']) >= 4.5 && contrast(c, surfaces['--cw-surface-hover']) >= 4.5
    && contrast(c, surfaces['--cw-surface-active']) >= 4.5)
  const blocked = filled(ansi(9, base['--cw-blocked'] as string))

  return {
    ...base,
    ...surfaces,
    '--cw-border': step(0.16),
    '--cw-border-strong': step(0.22),
    '--cw-border-hover': step(0.34),
    '--cw-scrollbar': step(0.3),
    '--cw-scrollbar-hover': step(0.4),
    '--cw-text': text,
    '--cw-text-bright': textBright,
    '--cw-text-dim': textDim,
    '--cw-accent': accent,
    '--cw-accent-hover': accentHover,
    '--cw-blocked': blocked,
    '--cw-danger-hover': nudge(mix(blocked, fg, 0.85), bg, (c) => contrast(bg, c) >= 4.5),
    '--cw-conflict': filled(ansi(13, base['--cw-conflict'] as string)),
    '--cw-working': washed(ansi(14, base['--cw-working'] as string)),
    '--cw-ready': washed(ansi(10, base['--cw-ready'] as string)),
    '--cw-needs-you': washed(ansi(11, base['--cw-needs-you'] as string)),
    '--cw-cursor': t.cursor ?? fg,
    ...(t.selection ? { '--cw-selection': t.selection } : {}),
  }
}

export type ThemeChoice = 'system' | 'dark' | 'light' | 'terminal'

export type ResolvedTheme = { name: 'dark' | 'light' | 'terminal'; colors: ColorTokens; scheme: 'dark' | 'light' }

/**
 * The theme to paint: `system` follows macOS; `terminal` needs imported colors and
 * falls back to the system's otherwise (said in Settings).
 */
export function resolveTheme(choice: ThemeChoice | undefined, terminal: TerminalColors | undefined, systemDark: boolean): ResolvedTheme {
  if (choice === 'terminal' && terminal) {
    return { name: 'terminal', colors: deriveColors(terminal), scheme: isDark(terminal.background) ? 'dark' : 'light' }
  }
  const light = choice === 'light' || ((choice === undefined || choice === 'system' || choice === 'terminal') && !systemDark)
  return light
    ? { name: 'light', colors: LIGHT_COLORS, scheme: 'light' }
    : { name: 'dark', colors: DARK_COLORS, scheme: 'dark' }
}

/** One Light's ANSI steps, for a pane on the light theme with nothing imported. */
const LIGHT_ANSI = {
  black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a1a7',
  brightBlack: '#4f525e', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
}

/** The pane's palette under a theme, before any imported terminal colors. */
export function xtermThemeFor(theme: ResolvedTheme): { [K in keyof typeof XTERM_THEME]: string } {
  const c = theme.colors
  const ansi = theme.scheme === 'light' ? LIGHT_ANSI : XTERM_THEME
  return {
    ...XTERM_THEME,
    ...Object.fromEntries(Object.keys(LIGHT_ANSI).map((k) => [k, (ansi as Record<string, string>)[k] as string])),
    background: c['--cw-surface'] as string,
    foreground: c['--cw-text'] as string,
    cursor: c['--cw-cursor'] as string,
    cursorAccent: c['--cw-surface'] as string,
    selectionBackground: c['--cw-selection'] as string,
  }
}

/** Paint `theme` on the window: every color token, and the browser's own controls. */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(theme.colors)) root.style.setProperty(name, value)
  root.style.colorScheme = theme.scheme
  root.dataset.theme = theme.name
}
