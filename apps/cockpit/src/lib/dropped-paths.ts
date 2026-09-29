const CONTROL = /[\x00-\x1f\x7f]/
const SHELL_SPECIAL = /[ \\'"`$&|;<>()[\]{}*?!#~^]/g

/**
 * A path as a shell word, the way Ghostty and iTerm2 type a dropped file: backslashes
 * before the special characters, everything else (Vietnamese letters included) verbatim.
 * A control character has no backslash form that survives the line editor — a raw
 * newline would submit the line — so such a path takes bash/zsh ANSI-C quoting instead.
 */
export function escapeShellPath(path: string): string {
  if (CONTROL.test(path)) {
    const body = Array.from(path, (ch) => {
      if (ch === '\\' || ch === "'") return `\\${ch}`
      return CONTROL.test(ch) ? `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}` : ch
    }).join('')
    return `$'${body}'`
  }
  return path.replace(SHELL_SPECIAL, '\\$&')
}

/** What a drop types into the terminal: each path escaped, a space after every one. */
export function droppedPathsText(paths: readonly string[]): string {
  return paths
    .filter((p) => p !== '')
    .map((p) => `${escapeShellPath(p)} `)
    .join('')
}

/** Whether a drag carries files (from Finder) rather than text or a pane being moved. */
export function isFileDrag(types: ArrayLike<string> | undefined): boolean {
  return Array.from(types ?? []).includes('Files')
}
