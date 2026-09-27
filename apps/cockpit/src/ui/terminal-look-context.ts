import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { TerminalAppearance } from '../../../../src/core/settings.js'
import type { XtermTheme } from '../lib/terminal-look'
import { DARK_COLORS, xtermThemeFor, type ColorTokens } from './themes'

/** Settings → Terminal, for every pane in the window; undefined is the cockpit's own look. */
export const TerminalLookContext = createContext<TerminalAppearance | undefined>(undefined)

export function useTerminalLook(): TerminalAppearance | undefined {
  return useContext(TerminalLookContext)
}

/** The window theme's colors and the pane palette it implies (before imported colors). */
export type PaneTheme = { colors: ColorTokens; xterm: XtermTheme }

export const PaneThemeContext = createContext<PaneTheme>({
  colors: DARK_COLORS,
  xterm: xtermThemeFor({ name: 'dark', colors: DARK_COLORS, scheme: 'dark' }),
})

export function usePaneTheme(): PaneTheme {
  return useContext(PaneThemeContext)
}
