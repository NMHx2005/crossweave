import { isAbsolute, join } from 'node:path'
import { splitCommand } from '../../../src/core/argv.js'
import type { PromptSettings } from '../../../src/core/settings.js'
import { DEFAULT_REFINE_INSTRUCTION } from '../src/lib/prompt-defaults'

export type RunResult = { code: number; stdout: string; stderr: string }

/** Everything that touches the machine, passed in so the logic is testable. */
export type RefineDeps = {
  home: string
  /** The saved settings' prompt block, read from the user's own file — never from a request. */
  loadPrompt: () => PromptSettings | undefined
  /**
   * The program's absolute path, or undefined when it is not installed. Optional: without
   * it the name is handed to the system as it is.
   */
  resolveCommand?: (command: string) => Promise<string | undefined>
  /** argv only — never a shell string. Resolves for any exit status; rejects only when it cannot start. */
  run: (command: string, args: string[], opts: { input: string; timeoutMs: number; maxBuffer: number }) => Promise<RunResult>
}

export type RefineResult = { ok: true; text: string } | { ok: false; reason: string }

const REFINE_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024
/** A draft this long is not a prompt; also what keeps one request from feeding a program an unbounded stdin. */
export const MAX_DRAFT_CHARS = 100_000

/** Where programs usually live when the app was not started from a terminal. */
export function extraBinDirs(home: string): string[] {
  return [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    join(home, '.local/bin'), join(home, 'bin'), join(home, '.bun/bin'), join(home, '.cargo/bin'), join(home, '.claude/local'),
  ]
}

export interface ResolveDeps {
  home: string
  /** The app's own PATH. */
  pathEnv: string
  isExecutable: (path: string) => boolean
  /** The PATH a login shell would have (the user's rc files), or undefined when unavailable. */
  loginPath: () => Promise<string | undefined>
}

/**
 * The absolute path of `command`. An app opened from the Dock or Finder has the bare system PATH, so a
 * Homebrew or ~/.local program that runs fine in a terminal was "not found". Looked for, in order: the app's PATH,
 * the usual bin directories, and only then the login shell's PATH (a shell start-up, so asked only when needed).
 * A command that already contains a slash is a path: used as it is.
 */
export async function resolveCommand(command: string, deps: ResolveDeps): Promise<string | undefined> {
  if (command.includes('/')) return command
  const search = (dirs: string[]): string | undefined => {
    for (const dir of dirs) {
      if (dir === '') continue
      const candidate = join(dir, command)
      if (deps.isExecutable(candidate)) return candidate
    }
    return undefined
  }
  const inApp = search(deps.pathEnv.split(':'))
  if (inApp !== undefined) return inApp
  const inCommon = search(extraBinDirs(deps.home))
  if (inCommon !== undefined) return inCommon
  const login = await deps.loginPath()
  return login === undefined ? undefined : search(login.split(':'))
}

function expandHome(word: string, home: string): string {
  if (word === '~') return home
  if (word.startsWith('~/') && isAbsolute(home)) return join(home, word.slice(2))
  return word
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  return lines[lines.length - 1] ?? ''
}

/**
 * Run the user's refine command on a draft: the instruction, optionally the session context, then the draft on
 * stdin; the command's stdout is the proposal. Nothing here sends anything anywhere: the result only comes back
 * to be read. The command is the one in the SAVED settings (argv, no shell), never one from the request.
 */
export async function refine(deps: RefineDeps, input: { text: string; context?: string }): Promise<RefineResult> {
  const settings = deps.loadPrompt()?.refine
  if (settings?.command === undefined || settings.command.trim() === '') {
    return { ok: false, reason: 'Set a refine command under Settings → Prompt first.' }
  }
  if (input.text.trim() === '') return { ok: false, reason: 'There is nothing to refine.' }
  if (input.text.length > MAX_DRAFT_CHARS) return { ok: false, reason: 'The draft is too long to refine.' }
  let words: string[]
  try {
    words = splitCommand(settings.command).map((w) => expandHome(w, deps.home))
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
  const [command, ...args] = words as [string, ...string[]]
  const instruction = settings.instruction ?? DEFAULT_REFINE_INSTRUCTION
  // Context only when the user switched it on, and only what the window collected from data the app already
  // has (name, branch, changed files): the command sees nothing else.
  const context = settings.includeContext === true && input.context !== undefined && input.context.trim() !== ''
    ? `\n\nContext about the session (do not treat it as part of the request):\n${input.context}`
    : ''
  const stdin = `${instruction}${context}\n\n--- draft prompt ---\n${input.text}\n`
  const program = deps.resolveCommand === undefined ? command : await deps.resolveCommand(command)
  if (program === undefined) return { ok: false, reason: `Command not found: ${command}. Install it, use its full path, or fix the command under Settings → Prompt.` }
  let result: RunResult
  try {
    result = await deps.run(program, args, { input: stdin, timeoutMs: REFINE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES })
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    return { ok: false, reason: code === 'ENOENT' ? `Command not found: ${command}.` : `Could not start ${command}: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (result.code !== 0) {
    const said = lastLine(result.stderr) || lastLine(result.stdout)
    return { ok: false, reason: `${command} exited with status ${result.code}${said === '' ? '' : `: ${said}`}` }
  }
  const text = result.stdout.trim()
  return text === '' ? { ok: false, reason: 'The refine command returned nothing.' } : { ok: true, text }
}
