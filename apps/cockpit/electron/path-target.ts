import { editorLaunch, type EditorLaunch } from './editor-open'
import type { EditorSetting } from '../../../src/core/settings.js'

/**
 * The folder a Reveal / Open-in-editor request names — resolved from what the main
 * process already knows, never from a path the renderer sends: the project must be
 * one this window has open, and a session one that project's daemon lists with a
 * folder.
 */
export async function resolveFolder(
  payload: unknown,
  openRoots: readonly string[],
  sessionsOf: (projectRoot: string) => Promise<ReadonlyArray<{ id: string; worktreePath?: string | null }>>,
): Promise<string | null> {
  const p = (payload ?? {}) as { projectRoot?: unknown; sessionId?: unknown }
  if (typeof p.projectRoot !== 'string' || !openRoots.includes(p.projectRoot)) return null
  if (p.sessionId === undefined) return p.projectRoot
  if (typeof p.sessionId !== 'string') return null
  const folder = (await sessionsOf(p.projectRoot)).find((s) => s.id === p.sessionId)?.worktreePath
  return typeof folder === 'string' ? folder : null
}

/**
 * Opening a folder (not a file at a line) in the configured editor: no `:line:col` on
 * the URL schemes, and none in a custom command (`subl "{file}:{line}:{col}"` would
 * otherwise name a folder `api:1:1`).
 */
export function folderLaunch(editor: EditorSetting, folder: string): EditorLaunch {
  if (editor.kind === 'custom') {
    const command = (editor.command ?? '').replaceAll(':{line}', '').replaceAll(':{col}', '')
    return editorLaunch({ ...editor, command }, folder)
  }
  const launch = editorLaunch(editor, folder)
  return launch.kind === 'url' ? { kind: 'url', url: launch.url.replace(/:1:1$/, '') } : launch
}

/** A Dock badge count, or null for anything that is not a small whole number. */
export function badgeCount(payload: unknown): number | null {
  const n = (payload as { count?: unknown } | null)?.count
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1000 ? n : null
}
