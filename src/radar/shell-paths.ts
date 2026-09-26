/**
 * Best-effort extraction of the files a shell command line plausibly WRITES or
 * DELETES, for the Radar's advisory-only `Bash` path
 * (docs/superpowers/specs/2026-09-17-tier-coverage-honesty-design.md §3.3).
 *
 * This is deliberately a tokenizer plus a small operator table, NOT a shell parser:
 * a real parser is a dependency and a maintenance surface of its own, while a
 * shell parser's `eval`-class cousins are exactly what §5 of the M5a design warns
 * against. Consequences, accepted on purpose:
 *
 *  - It MISSES writes it does not recognise (a script the agent wrote and then ran,
 *    a heredoc, an `xargs`, a variable holding a path). A miss costs one advisory
 *    notice, never a block — the caller is forbidden from denying on this input.
 *  - It can over-collect (a `>` inside a quoted string, a token that is a value
 *    rather than a path). The caller re-validates every candidate against the
 *    worktree root and the collision check does the real filtering, so a bad
 *    candidate costs a wasted lookup, not a false alarm shown to an agent.
 *
 * Bounded by `MAX_TARGETS` so a pathological command cannot turn one hook
 * invocation into unbounded RPC work inside its 5s budget.
 */

/** Write-ish operators whose operands are files. Command names are matched on the
 * basename so `/usr/bin/tee` behaves like `tee`. */
const PATH_TAKING_COMMANDS = new Set([
  'rm', 'touch', 'truncate', 'tee', 'cp', 'mv', 'install', 'ln', 'shred',
  'unlink', 'rsync', 'dd', 'sed',
]);
/** Flags whose NEXT token is a value, not an operand (`truncate -s 0 f.txt`). */
const VALUE_TAKING_FLAGS = new Set(['-s', '--size']);
/** Commands where only the operands AFTER the subcommand matter. */
const GIT_WRITING_SUBCOMMANDS = new Set(['checkout', 'restore', 'rm', 'clean', 'apply']);

export const MAX_TARGETS = 5;

const SHELL_SEPARATORS = new Set([';', '|', '&', '\n']);

/**
 * Splits a command line into segments of tokens, honoring single/double quotes and
 * `\` escapes, and breaking on unquoted `;`, `|`, `&` and newlines. Redirection
 * characters are NOT operators to this splitter — they stay glued to their token
 * (`>out.txt`, `hi>out.txt`, `2>/dev/null`), which `redirectTarget` below unpicks.
 */
function splitSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  const endToken = (): void => {
    if (hasToken) tokens.push(token);
    token = '';
    hasToken = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === '\\' && quote !== "'" && i + 1 < command.length) {
      token += command[i + 1];
      hasToken = true;
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else token += ch;
      hasToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true; // an empty quoted string is still an argument
      continue;
    }
    if (SHELL_SEPARATORS.has(ch)) {
      // `&&` / `||` are two characters but mean the same thing here: a new segment.
      endSegment();
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endToken();
      continue;
    }
    token += ch;
    hasToken = true;
  }
  endSegment();
  return segments;
}

/**
 * The path a redirect token writes to, or `undefined` when the token is not a
 * file redirect. Handles the attached (`>out.txt`, `sed -i s/a/b/ x>y`), detached
 * (`> out.txt`, `>>  out.txt`) and fd-duplication (`2>&1`, `1>&2`) forms — the last
 * one names a file descriptor, not a file, and is skipped.
 */
function redirectTarget(token: string, next: string | undefined): string | undefined {
  const at = token.lastIndexOf('>');
  if (at === -1) return undefined;
  const attached = token.slice(at + 1).trim();
  if (attached !== '') return attached.startsWith('&') ? undefined : attached;
  const following = next?.trim();
  if (following === undefined || following === '') return undefined;
  return following.startsWith('&') ? undefined : following;
}

function basename(token: string): string {
  const at = token.lastIndexOf('/');
  return at === -1 ? token : token.slice(at + 1);
}

function isFlag(token: string): boolean {
  return token.startsWith('-') && token !== '-';
}

/** The operands a segment's command writes through, or `[]` for commands this
 * module does not recognise as writers. */
function operandsOf(tokens: string[]): string[] {
  const command = basename(tokens[0] ?? '');
  if (command === 'git') {
    const sub = tokens[1];
    return sub !== undefined && GIT_WRITING_SUBCOMMANDS.has(sub) ? tokens.slice(2) : [];
  }
  if (!PATH_TAKING_COMMANDS.has(command)) return [];

  const rest = tokens.slice(1);
  if (command === 'dd') return rest.filter((t) => t.startsWith('of=')).map((t) => t.slice(3));
  if (command === 'sed') return sedFileOperands(rest);

  const operands: string[] = [];
  let skipValue = false;
  for (const token of rest) {
    if (skipValue) { skipValue = false; continue; }
    if (VALUE_TAKING_FLAGS.has(token)) { skipValue = true; continue; }
    if (isFlag(token)) continue;
    operands.push(token);
  }
  return operands;
}

/**
 * `sed -i 's/a/b/' file.ts` — the first non-flag operand is the SCRIPT (or the value
 * of `-e`), and the files come after it. The `-i` requirement itself is enforced by
 * the caller: a read-only `sed` writes nothing.
 */
function sedFileOperands(rest: string[]): string[] {
  const operands: string[] = [];
  let scriptSeen = false;
  let skipValue = false;
  for (const token of rest) {
    if (skipValue) { skipValue = false; continue; }
    if (token === '-e' || token === '--expression' || token === '-f' || token === '--file') {
      skipValue = true; // the next token is the script (or the script file)
      continue;
    }
    if (isFlag(token)) continue;
    if (!scriptSeen) { scriptSeen = true; continue; }
    operands.push(token);
  }
  return operands;
}

/** Collects candidate write targets from one segment into `out`. Redirects are
 * scanned over the whole segment, since one segment can hold several writes
 * (`sed -i s/a/b/ x.ts > y.ts`) and the operators are not mutually exclusive. */
function collectSegment(tokens: string[], out: string[]): void {
  for (let i = 0; i < tokens.length; i += 1) {
    const redirect = redirectTarget(tokens[i]!, tokens[i + 1]);
    if (redirect !== undefined) {
      out.push(redirect);
      // A detached redirect (`>` then the path) consumes the following token.
      if (tokens[i]!.endsWith('>')) i += 1;
    }
  }

  const command = basename(tokens[0] ?? '');
  if (command === 'sed' && !tokens.some(isSedInPlaceFlag)) {
    return; // a read-only sed invocation (including `-i` with a backup suffix, `-i.bak`)
  }
  for (const operand of operandsOf(tokens)) {
    if (operand !== '--') out.push(operand); // an argument separator, not a path
  }
}

/**
 * Whether one sed argument turns on in-place editing: `--in-place`, or an `i`/`I`
 * anywhere in a short-flag cluster (`-i`, `-ni`, `-Ei`) before a flag that takes the
 * rest of the token as its argument — `-es/x/i/` is a script, not `-i`.
 */
function isSedInPlaceFlag(token: string): boolean {
  if (token.startsWith('--')) return token.startsWith('--in-place');
  if (!token.startsWith('-')) return false;
  for (const flag of token.slice(1)) {
    if (flag === 'i' || flag === 'I') return true;
    if (flag === 'e' || flag === 'f' || flag === 'l') return false;
  }
  return false;
}

/** Deduplicated, capped, best-effort — see this module's header for what that means. */
export function extractWriteTargets(command: string): string[] {
  const found: string[] = [];
  for (const segment of splitSegments(command)) {
    collectSegment(segment, found);
    if (new Set(found).size >= MAX_TARGETS) break;
  }
  return [...new Set(found)].filter((t) => t !== '' && t !== '/dev/null').slice(0, MAX_TARGETS);
}
