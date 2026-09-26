import { splitCommand } from '../../../../src/core/argv.js'
import { sessionNameError } from './quick-picker'

/**
 * The ⌘K command bar's language: `cw`'s verbs, typed. Parsing is pure and separate
 * from the UI so every verb, default and refusal is pinned by a test; the bar only
 * turns a parsed command into the same actions the menus and buttons run.
 */

export type CommandContext = {
  sessions: Array<{ id: string; name: string; status?: string }>
  /** The session a verb acts on when none is named. */
  focusedName: string | null
}

export type Command =
  | { kind: 'new'; name: string; base?: string; shared: boolean }
  | { kind: 'start'; session: string }
  | { kind: 'stop'; session: string }
  | { kind: 'kill'; session: string; removeWorktree: boolean }
  | { kind: 'land'; session: string }
  | { kind: 'land-all' }
  | { kind: 'diff'; session: string }
  | { kind: 'terminal'; session: string }
  | { kind: 'rename'; session: string; to: string }
  | { kind: 'open'; path?: string }
  | { kind: 'browser'; url?: string }
  | { kind: 'attention' }
  | { kind: 'settings' }
  | { kind: 'buttons'; on: boolean }
  | { kind: 'gc'; force: boolean }
  | { kind: 'help' }

export type ParsedCommand = { ok: true; command: Command } | { ok: false; error: string }

type ArgKind = 'session' | 'none'

export type CommandSpec = { name: string; aliases?: string[]; usage: string; summary: string; arg: ArgKind }

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'new', usage: 'new <name> [--base <ref>] [--shared]', summary: 'A worktree and a shell in it', arg: 'none' },
  { name: 'start', usage: 'start [session]', summary: "Open the session's shell again", arg: 'session' },
  { name: 'stop', usage: 'stop [session]', summary: 'Close the shell (and what runs in it); the worktree stays', arg: 'session' },
  { name: 'kill', usage: 'kill [session] [--rm]', summary: 'End the session; --rm also deletes its worktree', arg: 'session' },
  { name: 'land', usage: 'land [session] | land --all', summary: 'Merge the session into the base', arg: 'session' },
  { name: 'diff', usage: 'diff [session]', summary: 'Show what the session changed', arg: 'session' },
  { name: 'term', aliases: ['terminal'], usage: 'term [session]', summary: 'Another shell in the session\'s worktree', arg: 'session' },
  { name: 'rename', usage: 'rename <session> <new-name>', summary: 'Rename a session', arg: 'session' },
  { name: 'open', usage: 'open [path]', summary: 'Open a file from the session\'s worktree', arg: 'none' },
  { name: 'browser', usage: 'browser [url]', summary: 'Open a browser pane', arg: 'none' },
  { name: 'next', aliases: ['attention'], usage: 'next', summary: 'Jump to the session that needs you', arg: 'none' },
  { name: 'settings', usage: 'settings', summary: 'Editor and cockpit settings', arg: 'none' },
  { name: 'buttons', usage: 'buttons on|off', summary: 'Show or hide the rail\'s action buttons', arg: 'none' },
  { name: 'gc', usage: 'gc [--force]', summary: 'Remove ended sessions\' worktrees', arg: 'none' },
  { name: 'help', usage: 'help', summary: 'List every command', arg: 'none' },
]

function specFor(word: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === word || c.aliases?.includes(word))
}

export function parseCommand(line: string, ctx: CommandContext): ParsedCommand {
  let all: string[]
  try {
    all = line.trim() === '' ? [] : splitCommand(line)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (all.length === 0) return { ok: false, error: 'Type a command — `help` lists them' }
  const [verb, ...words] = all as [string, ...string[]]
  const spec = specFor(verb)
  if (spec === undefined) return { ok: false, error: `Unknown command: ${verb} — \`help\` lists them` }

  const flags = words.filter((w) => w.startsWith('--'))
  const positional = words.filter((w) => !w.startsWith('--'))
  const fail = (error: string): ParsedCommand => ({ ok: false, error })
  const allowOnly = (...allowed: string[]): string | undefined =>
    flags.find((f) => !allowed.includes(f) && !allowed.some((a) => f.startsWith(`${a}=`)))

  const session = (name: string | undefined): { id: string } | { error: string } => {
    const wanted = name ?? ctx.focusedName
    if (wanted === null) return { error: `No session selected — name one: ${spec.usage}` }
    const found = ctx.sessions.find((s) => s.name === wanted || s.id === wanted)
    return found === undefined ? { error: `No session named ${wanted}` } : { id: found.id }
  }
  const withSession = (make: (id: string) => Command): ParsedCommand => {
    if (positional.length > 1) return fail(`Too many arguments — ${spec.usage}`)
    const s = session(positional[0])
    return 'error' in s ? fail(s.error) : { ok: true, command: make(s.id) }
  }
  const stray = (...allowed: string[]): ParsedCommand | undefined => {
    const bad = allowOnly(...allowed)
    return bad === undefined ? undefined : fail(`${spec.name} does not take ${bad}`)
  }

  switch (spec.name) {
    case 'new': {
      const bad = allowOnly('--base', '--shared')
      if (bad !== undefined) return fail(`new does not take ${bad}`)
      // `--base <ref>` consumes the word after it.
      const baseAt = words.indexOf('--base')
      const inline = flags.find((f) => f.startsWith('--base='))
      const base = inline !== undefined ? inline.slice('--base='.length) : baseAt === -1 ? undefined : words[baseAt + 1]
      if (baseAt !== -1 && (base === undefined || base.startsWith('--'))) return fail('--base needs a branch or commit')
      const names = words.filter((w, i) => !w.startsWith('--') && !(baseAt !== -1 && i === baseAt + 1))
      const [name] = names
      if (name === undefined) return fail(`Usage: ${spec.usage}`)
      if (names.length > 1) return fail(`Too many arguments — ${spec.usage}`)
      const nameError = sessionNameError(name)
      if (nameError !== null) return fail(`Session name: ${nameError}`)
      if (ctx.sessions.some((s) => s.name === name)) return fail(`A session named ${name} exists`)
      return {
        ok: true,
        command: { kind: 'new', name, shared: flags.includes('--shared'), ...(base === undefined ? {} : { base }) },
      }
    }
    case 'start':
      return stray() ?? withSession((id) => ({ kind: 'start', session: id }))
    case 'stop':
      return stray() ?? withSession((id) => ({ kind: 'stop', session: id }))
    case 'kill':
      return stray('--rm') ?? withSession((id) => ({ kind: 'kill', session: id, removeWorktree: flags.includes('--rm') }))
    case 'land':
      if (flags.includes('--all')) {
        return positional.length > 0 ? fail('land --all takes no session') : { ok: true, command: { kind: 'land-all' } }
      }
      return stray('--all') ?? withSession((id) => ({ kind: 'land', session: id }))
    case 'diff':
      return stray() ?? withSession((id) => ({ kind: 'diff', session: id }))
    case 'term':
      return stray() ?? withSession((id) => ({ kind: 'terminal', session: id }))
    case 'rename': {
      if (positional.length !== 2) return fail(`Usage: ${spec.usage}`)
      const s = session(positional[0])
      if ('error' in s) return fail(s.error)
      const to = positional[1] as string
      const nameError = sessionNameError(to)
      if (nameError !== null) return fail(`Session name: ${nameError}`)
      return stray() ?? { ok: true, command: { kind: 'rename', session: s.id, to } }
    }
    case 'open':
      return stray() ?? { ok: true, command: positional[0] === undefined ? { kind: 'open' } : { kind: 'open', path: positional[0] } }
    case 'browser':
      return stray() ?? { ok: true, command: positional[0] === undefined ? { kind: 'browser' } : { kind: 'browser', url: positional[0] } }
    case 'next':
      return stray() ?? { ok: true, command: { kind: 'attention' } }
    case 'settings':
      return stray() ?? { ok: true, command: { kind: 'settings' } }
    case 'buttons':
      if (positional[0] !== 'on' && positional[0] !== 'off') return fail(`Usage: ${spec.usage}`)
      return stray() ?? { ok: true, command: { kind: 'buttons', on: positional[0] === 'on' } }
    case 'gc':
      return stray('--force') ?? { ok: true, command: { kind: 'gc', force: flags.includes('--force') } }
    default:
      return stray() ?? { ok: true, command: { kind: 'help' } }
  }
}

export type Completion = { value: string; label: string; detail: string }

/**
 * What the current word can become. Values are whole lines, so accepting one is a
 * plain replace; each ends in a space, ready for the next word.
 */
export function completions(line: string, ctx: CommandContext): Completion[] {
  const words = line.split(/\s+/)
  const current = words.at(-1) ?? ''
  const before = words.slice(0, -1)
  const prefix = before.length === 0 ? '' : `${before.join(' ')} `
  if (before.length === 0) {
    return COMMANDS
      .filter((c) => c.name.startsWith(current))
      .map((c) => ({ value: `${c.name} `, label: c.name, detail: `${c.usage} — ${c.summary}` }))
  }
  const spec = specFor(before[0] as string)
  if (spec === undefined || current.startsWith('-')) return []
  if (spec.arg === 'session' && before.length === 1) {
    return ctx.sessions
      .filter((s) => s.name.startsWith(current))
      .map((s) => ({ value: `${prefix}${s.name} `, label: s.name, detail: s.status ?? '' }))
  }
  return []
}

const HISTORY_MAX = 20

/** A command history: newest first, without repeats. */
export function rememberLine(history: readonly string[], line: string): string[] {
  const trimmed = line.trim()
  if (trimmed === '') return [...history]
  return [trimmed, ...history.filter((l) => l !== trimmed)].slice(0, HISTORY_MAX)
}
