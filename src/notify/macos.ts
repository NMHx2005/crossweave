import { execFileSync } from 'node:child_process';

let terminalNotifierPath: string | undefined | null = null; // null = not yet checked

/**
 * Test-only: clears the process-lifetime `terminalNotifierPath` cache so each test
 * can re-resolve `terminal-notifier` against its own `execFileSync` mock. A `?t=N`
 * query-suffixed re-import per test (tried initially, per the task brief) does force
 * Bun to re-evaluate this module fresh at runtime, but `tsc --noEmit` can't resolve a
 * relative specifier with a query suffix under this repo's `moduleResolution:
 * bundler` — no ambient wildcard declaration matches it either. This exported reset
 * is the type-clean seam instead.
 */
export function __resetTerminalNotifierCacheForTests(): void {
  terminalNotifierPath = null;
}

/** Resolved once per daemon process — matches this daemon's other process-lifetime caches (e.g. SessionRuntime's `starting` set). */
function resolveTerminalNotifier(): string | undefined {
  if (terminalNotifierPath !== null) return terminalNotifierPath ?? undefined;
  try {
    terminalNotifierPath = execFileSync('which', ['terminal-notifier'], { encoding: 'utf8' }).trim();
  } catch {
    terminalNotifierPath = undefined;
  }
  return terminalNotifierPath ?? undefined;
}

/**
 * Wraps `s` as a single POSIX `sh` word: everything between the quotes is fully
 * literal (no `$`, backtick, or `\` expansion) except embedded `'` characters,
 * closed/re-opened/escaped via the standard `'\''` trick. Used both for the
 * `do script` payload below (protecting Terminal.app's own shell) and, in
 * `sendMacNotification`, for the whole `osascript -e` argument (protecting
 * `/bin/sh -c`, which is what `terminal-notifier` re-executes `-execute` through
 * on click — see that call site's comment).
 */
function posixSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Opens Terminal.app running `command` — not the user's actual preferred terminal
 * (iTerm2, kitty, etc.) if different, a known limitation (design doc §6). Built as an
 * AppleScript `do script` argument, itself one argv element to `osascript` — never a
 * hand-concatenated shell string (CLAUDE.md §5). `JSON.stringify` on the joined
 * command produces a valid double-quoted AppleScript string literal for any input
 * (AppleScript and JSON happen to share `"`/`\` escaping rules for a plain string),
 * closing the injection surface a naive `"..."` wrap would leave open for a
 * path/symbol containing a literal `"`.
 */
function openTerminalScript(command: string[]): string {
  const shellCommand = command.map((c) => posixSingleQuote(c)).join(' ');
  return `tell application "Terminal" to do script ${JSON.stringify(shellCommand)}\ntell application "Terminal" to activate`;
}

export function sendMacNotification(title: string, message: string, clickCommand: string[] | undefined): void {
  const tn = resolveTerminalNotifier();
  if (tn !== undefined) {
    const args = ['-title', title, '-message', message];
    if (clickCommand !== undefined) {
      // `terminal-notifier` runs `-execute`'s value via `NSTask` as `/bin/sh -c
      // <value>` when the user clicks the notification (julienXX/terminal-notifier's
      // AppDelegate.m). `JSON.stringify` produces a *double*-quoted script argument,
      // and POSIX `sh -c` still performs `$`/backtick command substitution inside
      // double quotes — so a `clickCommand` element containing `$(...)` would execute
      // before osascript ever runs. `posixSingleQuote` on the whole script argument
      // closes that: single-quoted content is fully inert to `sh`.
      args.push('-execute', `osascript -e ${posixSingleQuote(openTerminalScript(clickCommand))}`);
    }
    execFileSync(tn, args, { stdio: 'ignore' });
    return;
  }
  // No click-through without terminal-notifier (design doc §3.2) — `display
  // notification` has no action mechanism at all.
  execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], {
    stdio: 'ignore',
  });
}

/** darwin only — every other platform gets a silent no-op (design doc §3.4, §1 non-goals). */
export function platformSend(): (title: string, message: string, clickCommand: string[] | undefined) => void {
  return process.platform === 'darwin' ? sendMacNotification : () => {};
}
