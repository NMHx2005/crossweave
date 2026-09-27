import { isFontFamilyName } from '../../../src/core/settings.js'

export type InstalledFont = { family: string; mono: boolean }

/**
 * Every font family macOS has, one per line, `M ` for fixed-pitch and `P ` for the
 * rest. Nothing from the caller reaches the script.
 */
export const FONT_LIST_SCRIPT =
  'ObjC.import("AppKit");var m=$.NSFontManager.sharedFontManager;' +
  'm.availableFontFamilies.js.map(function(x){var f=x.js;var n=$.NSFont.fontWithNameSize(f,12);' +
  'return ((!n.isNil()&&n.isFixedPitch)?"M ":"P ")+f}).join("\\n")'

/** Nerd Font patches and the like do not always report fixed pitch; their names say it. */
const MONO_NAME = /\b(mono|code|console|courier|menlo|monaco|consolas|iosevka|hack)\b|monospace/i

/**
 * The families a picker can offer: only names Settings will accept (so a pick never
 * fails on Save), hidden system faces (a leading dot) left out, sorted, no duplicates.
 */
export function parseFontList(stdout: string): InstalledFont[] {
  const byName = new Map<string, InstalledFont>()
  for (const line of stdout.split('\n')) {
    const m = /^([MP]) (.+)$/.exec(line.trim())
    if (!m) continue
    const family = (m[2] as string).trim()
    if (family.startsWith('.') || !isFontFamilyName(family)) continue
    const mono = m[1] === 'M' || MONO_NAME.test(family)
    const seen = byName.get(family)
    byName.set(family, { family, mono: mono || (seen?.mono ?? false) })
  }
  return [...byName.values()].sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: 'base' }))
}

let cached: Promise<InstalledFont[]> | undefined

/** Read once per app run: fonts are rarely installed mid-session, and the read takes ~0.7 s. */
export function listFonts(run: (command: string, args: string[]) => Promise<string | undefined>): Promise<InstalledFont[]> {
  cached ??= run('osascript', ['-l', 'JavaScript', '-e', FONT_LIST_SCRIPT]).then((out) => {
    const fonts = parseFontList(out ?? '')
    // A failed read is not remembered: the next Settings open tries again.
    if (fonts.length === 0) cached = undefined
    return fonts
  })
  return cached
}
