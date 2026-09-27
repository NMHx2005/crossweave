import { execFile } from 'node:child_process';

/**
 * The aliases and functions the user's interactive shell defines.
 *
 * A launcher's command is typed into that shell, so a `cx` wrapper function or an
 * alias runs there as well as a program on PATH does — but a PATH lookup cannot see
 * it, and such a launcher was shown "not installed" and could not be picked. Read once
 * per daemon, like the login PATH (login-path.ts): shells are slow to start and
 * dotfiles rarely change mid-run.
 */

const MARK = '__CW_NAMES__';
const TIMEOUT_MS = 5_000;

/** The one-liner that lists them, for the shells that can; undefined for any other. */
export function namesScript(shell: string): string | undefined {
  const base = shell.split('/').pop() ?? '';
  if (base === 'zsh') return `printf '${MARK}'; print -rl -- \${(k)aliases} \${(k)functions}; printf '${MARK}'`;
  if (base === 'bash') return `printf '${MARK}'; compgen -a; compgen -A function; printf '${MARK}'`;
  return undefined;
}

/** The names between the markers, whatever the dotfiles printed around them. */
export function parseShellNames(stdout: string): Set<string> {
  const start = stdout.indexOf(MARK);
  const end = start < 0 ? -1 : stdout.indexOf(MARK, start + MARK.length);
  if (end < 0) return new Set();
  return new Set(stdout.slice(start + MARK.length, end).split('\n').map((l) => l.trim()).filter((l) => l !== ''));
}

export function readShellNames(shell: string, home = process.env.HOME ?? ''): Promise<Set<string>> {
  const script = namesScript(shell);
  if (script === undefined) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    try {
      execFile(shell, ['-i', '-l', '-c', script], {
        timeout: TIMEOUT_MS,
        encoding: 'utf8',
        // No TTY and a dumb terminal: dotfiles should not try to draw prompts.
        env: { HOME: home, USER: process.env.USER ?? '', SHELL: shell, TERM: 'dumb' },
      }, (_err, stdout) => resolve(parseShellNames(String(stdout ?? ''))));
    } catch {
      resolve(new Set());
    }
  });
}

let cached: Promise<Set<string>> | undefined;

export function loginShellNames(): Promise<Set<string>> {
  cached ??= readShellNames(process.env.SHELL || '/bin/zsh');
  return cached;
}
