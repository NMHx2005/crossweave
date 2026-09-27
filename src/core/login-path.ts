import { execFile } from 'node:child_process';

/**
 * The PATH the user's own terminal has.
 *
 * The daemon inherits whatever PATH started it, and a cockpit opened from the Dock or
 * Finder starts with launchd's minimal one — no ~/.local/bin, no ~/.opencode/bin, no
 * npm globals — so agents the user can run in any terminal were "not installed" and
 * failed to spawn. An interactive login shell runs the same dotfiles a terminal does;
 * the value is fenced with markers because those dotfiles may print banners.
 */

const MARK = '__CW_PATH__';
const TIMEOUT_MS = 5_000;

export function extractMarkedPath(stdout: string): string | undefined {
  const start = stdout.indexOf(MARK);
  if (start < 0) return undefined;
  const end = stdout.indexOf(MARK, start + MARK.length);
  if (end < 0) return undefined;
  const value = stdout.slice(start + MARK.length, end);
  return value === '' ? undefined : value;
}

/** `first`'s entries in order, then any of `second`'s it lacks. */
export function mergePaths(first: string | undefined, second: string | undefined): string | undefined {
  const out: string[] = [];
  for (const part of [...(first ?? '').split(':'), ...(second ?? '').split(':')]) {
    if (part !== '' && !out.includes(part)) out.push(part);
  }
  return out.length === 0 ? undefined : out.join(':');
}

export function readLoginShellPath(shell: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(shell, ['-i', '-l', '-c', `printf '${MARK}%s${MARK}' "$PATH"`], {
        timeout: TIMEOUT_MS,
        encoding: 'utf8',
        // No TTY and a dumb terminal: dotfiles should not try to draw prompts.
        env: { HOME: process.env.HOME ?? '', USER: process.env.USER ?? '', SHELL: shell, TERM: 'dumb' },
      }, (err, stdout) => resolve(err ? undefined : extractMarkedPath(String(stdout))));
    } catch {
      resolve(undefined);
    }
  });
}

let cached: Promise<string | undefined> | undefined;

/** Read once per daemon; shells are slow to start and dotfiles rarely change mid-run. */
export function loginShellPath(): Promise<string | undefined> {
  cached ??= readLoginShellPath(process.env.SHELL || '/bin/zsh');
  return cached;
}
