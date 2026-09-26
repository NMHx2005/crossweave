import { CrossweaveError } from './errors.js';

/*
 * Command lines as argv, never through a shell. Kept apart from settings.ts (which
 * touches the filesystem) so Electron's main process can split a custom editor
 * command exactly the way the daemon validated it.
 */

/** Shell-style word splitting — quotes and backslash escapes — without a shell. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < command.length) { cur += command[++i]; inWord = true; continue; }
    if (/\s/.test(c)) {
      if (inWord) { out.push(cur); cur = ''; inWord = false; }
      continue;
    }
    cur += c;
    inWord = true;
  }
  if (quote !== null) throw new CrossweaveError('INVALID_COMMAND', `Unbalanced quote in command: ${command}`);
  if (inWord) out.push(cur);
  if (out.length === 0) throw new CrossweaveError('INVALID_COMMAND', 'Command is empty');
  return out;
}
