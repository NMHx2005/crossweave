import type { PersistenceSettings, PromptSettings } from '../../../src/core/settings.js'

/**
 * The daemon that serves a project can be older than the app (it keeps running across app
 * updates: closing the app does not end sessions). One that predates a settings block neither
 * returns it from `settings.get` nor keeps it on `settings.set`, and its save rewrites the whole
 * file — so the user's setup would quietly disappear the first time any setting changed. The
 * main process reads and writes the same file itself, so it mends both ends, for each block
 * that arrived after the first release (`persistence`, `prompt`).
 */
export type GuardedSettings = { persistence?: PersistenceSettings; prompt?: PromptSettings }
const GUARDED = ['persistence', 'prompt'] as const

/** `settings.get`: an answer lacking a guarded block gets the file's, when there is one. */
export function withGuardedFromFile(answer: unknown, file: GuardedSettings): unknown {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return answer
  const missing = GUARDED.filter((k) => file[k] !== undefined && (answer as Record<string, unknown>)[k] === undefined)
  if (missing.length === 0) return answer
  return { ...(answer as Record<string, unknown>), ...Object.fromEntries(missing.map((k) => [k, file[k]])) }
}

/**
 * `settings.set`: the guarded blocks to write back — those the request carried and the file lost.
 * A request WITHOUT a block is left alone: that is the user clearing it on purpose.
 */
export function restoreGuarded(payload: unknown, fileAfter: GuardedSettings): GuardedSettings {
  const settings = (payload as { settings?: unknown } | null)?.settings
  if (typeof settings !== 'object' || settings === null) return {}
  const out: Record<string, unknown> = {}
  for (const k of GUARDED) {
    const sent = (settings as Record<string, unknown>)[k]
    if (typeof sent === 'object' && sent !== null && Object.keys(sent).length > 0 && fileAfter[k] === undefined) out[k] = sent
  }
  return out as GuardedSettings
}
