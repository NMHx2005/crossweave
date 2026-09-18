/**
 * What a bare `cw` means, decided in one place so it can be tested without a terminal.
 *
 * `claude` and `codex` open their app when invoked with no arguments; crossweave now
 * does the same, because "run the tool" and "read a command list" are different
 * intentions and the first one is the common case.
 *
 * The TTY check is not a nicety. A full-screen renderer written into a pipe is not a
 * degraded app — it is garbage in someone's log, and the caller that most needs the
 * help text (`cw | grep`, a script, CI) is exactly the caller that has no terminal.
 * So: no terminal means no app, and the previous output is preserved byte for byte.
 *
 * `argv` is the full `process.argv`, hence the length-2 test rather than "no
 * arguments": `cw -h` and `cw tui` are both length 3 and must not be re-routed.
 */
export function shouldOpenApp(argv: readonly string[], isTty: boolean): boolean {
  return argv.length === 2 && isTty;
}
