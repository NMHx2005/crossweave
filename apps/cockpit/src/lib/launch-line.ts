import { joinArgs, splitCommand } from '../../../../src/core/argv.js'

/**
 * The launch line a stopped session shows: the agent's command from Settings, then
 * the flags this session was last started with. What is shown is what runs — the
 * same argv splitting the daemon uses, never a shell.
 */
export function launchLineFor(agentCommand: string, launchArgs: readonly string[] | null | undefined): string {
  return joinArgs([...splitCommand(agentCommand), ...(launchArgs ?? [])])
}

export type ParsedLaunchLine = { ok: true; args: string[] } | { ok: false; error: string }

/**
 * The flags in a launch line the user typed. The line must begin with the agent's
 * configured command: which program runs is Settings' decision, so a launch line can
 * add flags but can never swap the agent for another program.
 */
export function parseLaunchLine(line: string, agentCommand: string): ParsedLaunchLine {
  let words: string[]
  let command: string[]
  try {
    words = splitCommand(line)
    command = splitCommand(agentCommand)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const matches = command.every((word, i) => words[i] === word)
  if (!matches) {
    return {
      ok: false,
      error: `The line must start with \`${agentCommand}\` — the command set for this agent in Settings (⌘,).`,
    }
  }
  return { ok: true, args: words.slice(command.length) }
}

const HISTORY_MAX = 20

/** A launch history: newest first, without repeats. */
export function rememberLine(history: readonly string[], line: string): string[] {
  const trimmed = line.trim()
  if (trimmed === '') return [...history]
  return [trimmed, ...history.filter((l) => l !== trimmed)].slice(0, HISTORY_MAX)
}
