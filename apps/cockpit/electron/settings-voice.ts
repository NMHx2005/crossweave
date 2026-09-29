import type { VoiceSettings } from '../../../src/core/settings.js'

/**
 * The daemon that serves a project can be older than the app (it keeps running across app
 * updates: closing the app does not end sessions). One that predates `voice` neither
 * returns it from `settings.get` nor keeps it on `settings.set`, and its save rewrites the
 * whole file — so the user's voice setup would quietly disappear the first time any setting
 * changed. The main process reads and writes the same file itself, so it mends both ends.
 */

/** `settings.get`: an answer without `voice` gets the file's, when there is one. */
export function withVoiceFromFile(answer: unknown, fileVoice: VoiceSettings | undefined): unknown {
  if (fileVoice === undefined || typeof answer !== 'object' || answer === null || Array.isArray(answer)) return answer
  if ((answer as { voice?: unknown }).voice !== undefined) return answer
  return { ...(answer as Record<string, unknown>), voice: fileVoice }
}

/**
 * `settings.set`: the voice to write back, if the request carried one and the file lost it.
 * A request WITHOUT voice is left alone — that is the user clearing it on purpose.
 */
export function restoreVoice(payload: unknown, fileAfter: { voice?: VoiceSettings }): VoiceSettings | undefined {
  const settings = (payload as { settings?: unknown } | null)?.settings
  if (typeof settings !== 'object' || settings === null) return undefined
  const sent = (settings as { voice?: unknown }).voice
  if (typeof sent !== 'object' || sent === null || Object.keys(sent).length === 0) return undefined
  return fileAfter.voice === undefined ? (sent as VoiceSettings) : undefined
}
