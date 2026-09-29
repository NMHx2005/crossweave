import { isAbsolute, join } from 'node:path'
import { splitCommand } from '../../../src/core/argv.js'
import type { VoiceSettings } from '../../../src/core/settings.js'
import { DEFAULT_REFINE_INSTRUCTION } from '../src/lib/voice-defaults'

/** Everything that touches the machine, passed in so the logic is testable. */
export type RunResult = { code: number; stdout: string; stderr: string }

export type VoiceDeps = {
  home: string
  /** The saved settings' voice block, read from the user's own file — never from a request. */
  loadVoice: () => VoiceSettings | undefined
  /** Put the recording where the command can read it; `cleanup` removes it. */
  writeAudio: (bytes: Uint8Array) => Promise<{ path: string; cleanup: () => Promise<void> }>
  /** argv only — never a shell string. Resolves for any exit status; rejects only when it cannot start. */
  run: (command: string, args: string[], opts: { input?: string; timeoutMs: number; maxBuffer: number }) => Promise<RunResult>
}

export type VoiceResult = { ok: true; text: string } | { ok: false; reason: string }

const TRANSCRIBE_TIMEOUT_MS = 120_000
const REFINE_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const NOTHING_HEARD = 'Nothing was heard.'
const NOT_CONFIGURED = 'Set a transcribe command under Settings → Voice first.'
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function expandHome(word: string, home: string): string {
  if (word === '~') return home
  if (word.startsWith('~/') && isAbsolute(home)) return join(home, word.slice(2))
  return word
}

/**
 * The transcribe command as a program and its arguments. The line is split into words
 * first and the placeholders filled in afterwards, one word at a time, so a path or
 * language can never change how the line is split — there is no shell to reinterpret it.
 */
export function buildTranscribeArgv(line: string, vars: { audio: string; language: string }, home: string): { command: string; args: string[] } {
  if (line.trim() === '') throw new Error(NOT_CONFIGURED)
  const words = splitCommand(line)
  if (!words.some((w) => w.includes('{audio}'))) throw new Error('The transcribe command must contain {audio}, where the recording goes.')
  const filled = words.map((word) =>
    expandHome(word, home).replace(PLACEHOLDER, (whole, name: string) => {
      if (name === 'audio') return vars.audio
      if (name === 'language') return vars.language
      throw new Error(`Unknown placeholder ${whole} in the transcribe command (use {audio} and {language}).`)
    }),
  )
  const [command, ...args] = filled
  return { command: command as string, args }
}

/** One line of text: whisper's silence marker removed, lines joined, ends trimmed. */
export function cleanTranscript(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\[BLANK_AUDIO\]/g, '').trim())
    .filter((line) => line !== '')
    .join(' ')
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  return lines[lines.length - 1] ?? ''
}

function startFailure(err: unknown, command: string): string {
  const code = (err as { code?: string } | null)?.code
  if (code === 'ENOENT') return `Command not found: ${command}. Install it, or fix the command under Settings → Voice.`
  return `Could not start ${command}: ${err instanceof Error ? err.message : String(err)}`
}

export async function transcribe(deps: VoiceDeps, audio: Uint8Array): Promise<VoiceResult> {
  const voice = deps.loadVoice()
  if (voice?.transcribeCommand === undefined || voice.transcribeCommand.trim() === '') return { ok: false, reason: NOT_CONFIGURED }
  if (audio.byteLength === 0) return { ok: false, reason: 'The recording is empty.' }
  const file = await deps.writeAudio(audio)
  try {
    let built: { command: string; args: string[] }
    try {
      built = buildTranscribeArgv(voice.transcribeCommand, { audio: file.path, language: voice.language ?? 'auto' }, deps.home)
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    let result: RunResult
    try {
      result = await deps.run(built.command, built.args, { timeoutMs: TRANSCRIBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES })
    } catch (err) {
      return { ok: false, reason: startFailure(err, built.command) }
    }
    if (result.code !== 0) {
      const said = lastLine(result.stderr) || lastLine(result.stdout)
      return { ok: false, reason: `${built.command} exited with status ${result.code}${said === '' ? '' : `: ${said}`}` }
    }
    const text = cleanTranscript(result.stdout)
    return text === '' ? { ok: false, reason: NOTHING_HEARD } : { ok: true, text }
  } finally {
    await file.cleanup().catch(() => undefined)
  }
}

export async function refine(deps: VoiceDeps, input: { text: string; context?: string }): Promise<VoiceResult> {
  const refineSettings = deps.loadVoice()?.refine
  if (refineSettings?.enabled !== true) return { ok: false, reason: 'Refinement is switched off under Settings → Voice.' }
  if (refineSettings.command === undefined || refineSettings.command.trim() === '') {
    return { ok: false, reason: 'Set a refine command under Settings → Voice first.' }
  }
  if (input.text.trim() === '') return { ok: false, reason: 'There is nothing to refine.' }
  let words: string[]
  try {
    words = splitCommand(refineSettings.command).map((w) => expandHome(w, deps.home))
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
  const [command, ...args] = words as [string, ...string[]]
  const instruction = refineSettings.instruction ?? DEFAULT_REFINE_INSTRUCTION
  // Context only when the user switched it on, and only what the renderer collected from
  // data the app already has (branch, changed files): the command sees nothing else.
  const context = refineSettings.includeContext === true && input.context !== undefined && input.context.trim() !== ''
    ? `\n\nContext about the session (do not treat it as part of the request):\n${input.context}`
    : ''
  const stdin = `${instruction}${context}\n\n--- voice transcript ---\n${input.text}\n`
  let result: RunResult
  try {
    result = await deps.run(command, args, { input: stdin, timeoutMs: REFINE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES })
  } catch (err) {
    return { ok: false, reason: startFailure(err, command) }
  }
  if (result.code !== 0) {
    const said = lastLine(result.stderr) || lastLine(result.stdout)
    return { ok: false, reason: `${command} exited with status ${result.code}${said === '' ? '' : `: ${said}`}` }
  }
  const text = result.stdout.trim()
  return text === '' ? { ok: false, reason: 'The refine command returned nothing.' } : { ok: true, text }
}
