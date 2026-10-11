import { COCKPIT_TOKENS } from '../../apps/cockpit/src/ui/tokens'
import { DARK_COLORS, LIGHT_COLORS } from '../../apps/cockpit/src/ui/themes'

// Only constants are imported from the cockpit: nothing here may call the functions that touch `document`. One token source means the
// site and the app cannot drift apart in colour or type.
const SHARED = ['--cw-font-ui', '--cw-font-mono', '--cw-hairline', '--cw-radius-sm', '--cw-radius', '--cw-radius-lg'] as const

const declarations = (colors: Record<string, string>): string =>
  Object.keys(colors)
    .sort()
    .map((name) => `${name}:${colors[name]}`)
    .join(';')

/** Dark is the default look; light follows `prefers-color-scheme`. The output is sorted, so it is deterministic. */
export function themeCss(): string {
  const shared = SHARED.map((name) => `${name}:${COCKPIT_TOKENS[name]}`).join(';')
  return [
    `:root{color-scheme:dark light;${shared};${declarations(DARK_COLORS)}}`,
    `@media (prefers-color-scheme: light){:root{${declarations(LIGHT_COLORS)}}}`,
    '',
  ].join('\n')
}

export const THEME_NAMES = { dark: DARK_COLORS, light: LIGHT_COLORS } as const

/** The text/background pairs `styles.css` paints, measured by the tests in both colour schemes. */
export const THEME_PAIRS: ReadonlyArray<{ fg: string; bg: string; where: string }> = [
  { fg: '--cw-text', bg: '--cw-surface', where: 'body text' },
  { fg: '--cw-text-bright', bg: '--cw-surface', where: 'headings and brand' },
  { fg: '--cw-text-dim', bg: '--cw-surface', where: 'secondary text' },
  { fg: '--cw-accent', bg: '--cw-surface', where: 'links' },
  { fg: '--cw-text', bg: '--cw-surface-overlay', where: 'card text' },
  { fg: '--cw-text-bright', bg: '--cw-surface-overlay', where: 'card titles' },
  { fg: '--cw-text-dim', bg: '--cw-surface-overlay', where: 'card qualifiers' },
  { fg: '--cw-accent', bg: '--cw-surface-overlay', where: 'links in cards' },
  { fg: '--cw-needs-you', bg: '--cw-surface-overlay', where: 'the "next release" badge and the note box' },
  { fg: '--cw-surface', bg: '--cw-accent', where: 'the primary button' },
  { fg: '--cw-surface', bg: '--cw-accent-hover', where: 'the primary button, hovered' },
  { fg: '--cw-text-bright', bg: '--cw-surface-control', where: 'the secondary button' },
  { fg: '--cw-text-bright', bg: '--cw-surface-control-hover', where: 'the secondary button, hovered' },
  { fg: '--cw-text-bright', bg: '--cw-surface-input', where: 'code lines' },
  { fg: '--cw-text-dim', bg: '--cw-surface-sidebar', where: 'the footer' },
  { fg: '--cw-text', bg: '--cw-surface-sidebar', where: 'the footer links' },
  { fg: '--cw-accent', bg: '--cw-surface-sidebar', where: 'the footer links' },
]
