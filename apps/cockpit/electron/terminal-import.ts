import { isAbsolute, join } from 'node:path'
import { cleanTerminal, type TerminalAppearance } from '../../../src/core/settings.js'
import { ghosttyAppearance, ghosttyThemeName, itermAppearance, parseGhosttyConfig } from '../../../src/core/terminal-import.js'

export type ImportSource = 'ghostty' | 'iterm2'

/** Everything that touches the machine, passed in so the mapping is testable. */
export type ImportDeps = {
  home: string
  /** $XDG_CONFIG_HOME, when set. */
  xdgConfigHome?: string
  readFile: (path: string) => string | undefined
  /** argv only — never a shell string. Resolves to stdout, or undefined on failure. */
  run: (command: string, args: string[]) => Promise<string | undefined>
}

export type ImportResult =
  | { ok: true; appearance: TerminalAppearance; notes: string[] }
  | { ok: false; reason: string }

const GHOSTTY_APP_THEMES = '/Applications/Ghostty.app/Contents/Resources/ghostty/themes'
const ITERM_PLIST = (home: string): string => join(home, 'Library/Preferences/com.googlecode.iterm2.plist')

/** Where Ghostty reads its config, in the order it applies them (later wins). */
export function ghosttyConfigPaths(home: string, xdgConfigHome?: string): string[] {
  const xdg = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(home, '.config')
  const appSupport = join(home, 'Library/Application Support/com.mitchellh.ghostty')
  return [join(xdg, 'ghostty/config'), join(xdg, 'ghostty/config.ghostty'), join(appSupport, 'config'), join(appSupport, 'config.ghostty')]
}

/** A theme's file: an absolute path as given, or a bare name in the user's then the app's themes. */
export function ghosttyThemePaths(name: string, home: string, xdgConfigHome?: string): string[] {
  if (isAbsolute(name)) return [name]
  // A bare name only: no way out of the themes directories.
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return []
  const xdg = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(home, '.config')
  return [join(xdg, 'ghostty/themes', name), join(GHOSTTY_APP_THEMES, name)]
}

/**
 * The family macOS has for a font name — a family ("JetBrainsMono Nerd Font Mono") or
 * a PostScript name ("JetBrainsMonoNFM-Regular"). Empty when the font is not installed.
 * The name is an argument to the script, never part of it.
 */
export const FONT_FAMILY_SCRIPT =
  'function run(argv){ObjC.import("AppKit");var f=$.NSFont.fontWithNameSize(argv[0],12);return f.isNil()?"":f.familyName.js}'

async function fontFamily(name: string, deps: ImportDeps): Promise<string | undefined> {
  const out = await deps.run('osascript', ['-l', 'JavaScript', '-e', FONT_FAMILY_SCRIPT, name])
  const family = out?.trim()
  return family ? family : undefined
}

/** Which terminals this machine has settings for. */
export function importSources(deps: ImportDeps): Record<ImportSource, boolean> {
  return {
    ghostty: ghosttyConfigPaths(deps.home, deps.xdgConfigHome).some((p) => deps.readFile(p) !== undefined),
    iterm2: deps.readFile(ITERM_PLIST(deps.home)) !== undefined,
  }
}

/**
 * The user's terminal's appearance, ready for Settings to show as a draft. Read-only:
 * nothing is saved here. What cannot be used is left out with a note saying why.
 */
export async function importTerminal(source: ImportSource, deps: ImportDeps): Promise<ImportResult> {
  const notes: string[] = []
  let appearance: TerminalAppearance
  let fontName: string | undefined

  if (source === 'ghostty') {
    const texts = ghosttyConfigPaths(deps.home, deps.xdgConfigHome).map((p) => deps.readFile(p)).filter((t): t is string => t !== undefined)
    if (texts.length === 0) return { ok: false, reason: 'No Ghostty config found (~/.config/ghostty/config)' }
    const config = parseGhosttyConfig(texts.join('\n'))
    const themeName = ghosttyThemeName(config)
    let theme: Array<[string, string]> | undefined
    if (themeName !== undefined) {
      const text = ghosttyThemePaths(themeName, deps.home, deps.xdgConfigHome).map((p) => deps.readFile(p)).find((t) => t !== undefined)
      if (text === undefined) notes.push(`Theme "${themeName}" was not found; only colors set in the config itself were used`)
      else theme = parseGhosttyConfig(text)
    }
    appearance = ghosttyAppearance(config, theme)
    fontName = appearance.fontFamily
  } else {
    const plist = ITERM_PLIST(deps.home)
    const json = await deps.run('plutil', ['-extract', 'New Bookmarks', 'json', '-o', '-', plist])
    if (json === undefined) return { ok: false, reason: 'No iTerm2 profiles found' }
    let profiles: unknown
    try {
      profiles = JSON.parse(json)
    } catch {
      return { ok: false, reason: 'Could not read iTerm2 profiles' }
    }
    const guid = (await deps.run('plutil', ['-extract', 'Default Bookmark Guid', 'raw', '-o', '-', plist]))?.trim()
    const read = itermAppearance(profiles as unknown[], guid)
    appearance = read.appearance
    fontName = read.fontPostScriptName
  }

  // Both apps may name a font this machine does not have (or name it in a form CSS
  // cannot use): keep the cockpit's rather than a family xterm falls back from silently.
  delete appearance.fontFamily
  if (fontName !== undefined) {
    const family = await fontFamily(fontName, deps)
    if (family !== undefined) appearance.fontFamily = family
    else notes.push(`Font "${fontName}" is not installed; the cockpit's font is kept`)
  }

  const { terminal, problems } = cleanTerminal(appearance)
  notes.push(...problems.map((p) => `Skipped — ${p}`))
  return { ok: true, appearance: terminal ?? { importedFrom: source }, notes }
}
