import type { TerminalAppearance } from '../../../../src/core/settings.js'
import { XTERM_FONT_FAMILY, XTERM_FONT_SIZE, XTERM_THEME } from '../ui/tokens'

const ANSI_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const

export type XtermTheme = { -readonly [K in keyof typeof XTERM_THEME]: string }

export type XtermLook = {
  fontFamily: string
  fontSize: number
  theme: XtermTheme
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  macOptionIsMeta: boolean
}

/**
 * The xterm options for an appearance from Settings (usually imported from Ghostty or
 * iTerm2), over the cockpit's own. Anything the appearance leaves out stays the
 * cockpit's — an imported palette without ANSI colors keeps the cockpit's sixteen.
 */
export function xtermLook(appearance: TerminalAppearance | undefined, base: XtermTheme = XTERM_THEME): XtermLook {
  const a = appearance ?? {}
  const theme: XtermTheme = { ...base }
  const c = a.colors
  if (c) {
    theme.background = c.background
    theme.foreground = c.foreground
    theme.cursor = c.cursor ?? c.foreground
    theme.cursorAccent = c.cursorText ?? c.background
    if (c.selection) theme.selectionBackground = c.selection
    if (c.ansi?.length === 16) ANSI_NAMES.forEach((name, i) => { theme[name] = c.ansi?.[i] as string })
  }
  return {
    // The imported family first; the cockpit's stack behind it for missing glyphs.
    fontFamily: a.fontFamily ? `"${a.fontFamily}", ${XTERM_FONT_FAMILY}` : XTERM_FONT_FAMILY,
    fontSize: a.fontSize ?? XTERM_FONT_SIZE,
    theme,
    cursorStyle: a.cursorStyle ?? 'block',
    cursorBlink: a.cursorBlink ?? true,
    macOptionIsMeta: a.optionAsMeta ?? false,
  }
}
