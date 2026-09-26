import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { splitCommand } from '../../../src/core/argv.js'
import type { EditorSetting } from '../../../src/core/settings.js'

export type EditorLaunch = { kind: 'url'; url: string } | { kind: 'exec'; argv: string[] }

const SCHEMES: Record<string, string> = { vscode: 'vscode', cursor: 'cursor', zed: 'zed' }

/**
 * How to open `file` at line:col. The three known editors are reached through their
 * own URL schemes — no dependence on a `code`/`cursor`/`zed` shim being on PATH. A
 * custom editor is argv with {file}/{line}/{col} substituted per argument, never a
 * shell string, so a file name cannot become a command.
 */
export function editorLaunch(editor: EditorSetting, file: string, line = 1, col = 1): EditorLaunch {
  const scheme = SCHEMES[editor.kind]
  if (scheme !== undefined) return { kind: 'url', url: `${scheme}://file${encodeURI(file)}:${line}:${col}` }
  const argv = splitCommand(editor.command ?? '').map((a) =>
    a.replaceAll('{file}', file).replaceAll('{line}', String(line)).replaceAll('{col}', String(col)))
  return { kind: 'exec', argv }
}

/**
 * The real file a link from a session's output points at, or null. An agent prints
 * whatever it likes, so a link only opens an existing file INSIDE its worktree —
 * `../../etc/passwd` and absolute paths elsewhere do not.
 */
export function resolveLinkTarget(worktree: string, raw: string): string | null {
  try {
    const root = realpathSync(worktree)
    const candidate = isAbsolute(raw) ? raw : join(root, raw)
    if (!existsSync(candidate)) return null
    const real = realpathSync(candidate)
    const rel = relative(root, real)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null
    if (!statSync(real).isFile()) return null
    return real
  } catch {
    return null
  }
}
