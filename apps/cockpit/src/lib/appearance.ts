import type { InterfaceAppearance } from '../../../../src/core/settings.js'
import { COCKPIT_TOKENS } from '../ui/tokens'

const SIZE_TOKENS = ['--cw-fs-micro', '--cw-fs-sm', '--cw-fs', '--cw-fs-rail', '--cw-fs-project'] as const
const SIZE_STEP: Record<NonNullable<InterfaceAppearance['textSize']>, number> = { small: -1, default: 0, large: 1 }

/**
 * The custom properties Settings → Appearance overrides on the window, always every
 * one of them, so choosing the default again puts the token back. A chosen family
 * leads and the cockpit's stack follows it for any glyph it lacks; a text size moves
 * every step of the type scale by one pixel, so their proportions hold.
 */
export function appearanceVars(appearance: InterfaceAppearance | undefined): Record<string, string> {
  const a = appearance ?? {}
  const vars: Record<string, string> = {
    '--cw-font-ui': a.uiFont ? `"${a.uiFont}", ${COCKPIT_TOKENS['--cw-font-ui']}` : COCKPIT_TOKENS['--cw-font-ui'],
    '--cw-font-mono': a.codeFont ? `"${a.codeFont}", ${COCKPIT_TOKENS['--cw-font-mono']}` : COCKPIT_TOKENS['--cw-font-mono'],
  }
  const step = SIZE_STEP[a.textSize ?? 'default']
  for (const name of SIZE_TOKENS) vars[name] = `${Number.parseInt(COCKPIT_TOKENS[name], 10) + step}px`
  return vars
}

/** Written on the root, over the tokens applyTokens() published at boot. */
export function applyAppearance(appearance: InterfaceAppearance | undefined, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(appearanceVars(appearance))) root.style.setProperty(name, value)
}
