import { splitCommand } from './argv.js';

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The program a launcher line runs — what has to be installed for it to work — past
 * any leading `VAR=value` assignments. Undefined when the line runs nothing or cannot
 * be read (an unbalanced quote): the launcher then shows as not available.
 */
export function launcherProgram(command: string): string | undefined {
  let words: string[];
  try {
    words = splitCommand(command);
  } catch {
    return undefined;
  }
  return words.find((w) => !ASSIGNMENT.test(w));
}
