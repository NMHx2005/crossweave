/** `session.diff`'s answer: what landing the session would bring in. */
export type SessionDiff = {
  files: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; added: number; deleted: number }>
  patch: string
  truncated: boolean
  /** Files changed in the worktree but not committed; landing does not take them. */
  uncommitted: number | null
}

/** One file's part of a unified diff, for rendering and for jumping to it. */
export type PatchSection = { path: string; lines: PatchLine[] }
/** `old`/`new` are the line numbers in the old/new file: an added line has `new`, a deleted one `old`, context both. */
export type PatchLine = { kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'; text: string; old?: number; new?: number }

function kindOf(line: string): PatchLine['kind'] {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')
    || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('Binary files')
    || line.startsWith('\\')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 }

/** git's C-style quoting (`core.quotePath`): `\303\251` is the two UTF-8 bytes of "é". `quoted` includes its quotes. */
function unquoteC(quoted: string): string {
  const inner = quoted.slice(1, -1)
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string
    if (c !== '\\') { bytes.push(...encoder.encode(c)); continue }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1))
    if (octal !== null) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length; continue }
    const next = inner[++i] ?? ''
    bytes.push(...(C_ESCAPES[next] !== undefined ? [C_ESCAPES[next]] : encoder.encode(next)))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** End index (exclusive) of a quoted token that starts at `from`, or -1. */
function quotedEnd(s: string, from: number): number {
  for (let i = from + 1; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '"') return i + 1
  }
  return -1
}

/**
 * The file's path from a `diff --git` line. The diff is --no-renames, so both sides name the same file: unquoted it is
 * `<p>/P <p>/P` and P is the last (length-5)/2 characters — which also survives a path containing " b/" and a
 * non-default diff prefix (`diff.mnemonicPrefix`); quoted, the second token is unquoted.
 */
function headerPath(line: string): string {
  const rest = line.slice('diff --git '.length)
  if (rest.startsWith('"')) {
    const first = quotedEnd(rest, 0)
    const secondStart = first < 0 ? -1 : rest.indexOf('"', first)
    const secondEnd = secondStart < 0 ? -1 : quotedEnd(rest, secondStart)
    if (secondEnd > 0) return unquoteC(rest.slice(secondStart, secondEnd)).slice(2)
  }
  const length = (rest.length - 5) / 2
  if (Number.isInteger(length) && length > 0) return rest.slice(rest.length - length)
  return /^.* [^/ ]+\/(.*)$/.exec(rest)?.[1] ?? rest
}

/**
 * `git diff` output split per file, with line numbers. A body line always starts with ` `, `+`, `-` or `\\`, so a line that
 * starts with `diff --git ` or `@@` is always a header and a section / hunk always starts there (whatever the counts say).
 * The hunk's counts do one job: inside a hunk a deleted `-- x` arrives as `--- x`, and only the counts tell it from a file header.
 */
export function patchSections(patch: string): PatchSection[] {
  const sections: PatchSection[] = []
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0
  // One trailing newline ends the last line; a patch cut right after a newline must not grow an empty one.
  for (const line of (patch.endsWith('\n') ? patch.slice(0, -1) : patch).split('\n')) {
    if (line.startsWith('diff --git ')) {
      sections.push({ path: headerPath(line), lines: [] })
      oldLeft = newLeft = 0
      continue
    }
    const current = sections.at(-1)
    if (current === undefined) continue
    const hunk = HUNK.exec(line)
    if (hunk !== null) {
      oldNo = Number(hunk[1]); oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newNo = Number(hunk[3]); newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      current.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (oldLeft > 0 || newLeft > 0) {
      // `diff.suppressBlankEmpty` writes a blank context line as '' instead of ' '.
      const mark = line === '' ? ' ' : line[0]
      if (mark === '+') { current.lines.push({ kind: 'add', text: line, new: newNo++ }); newLeft = Math.max(0, newLeft - 1); continue }
      if (mark === '-') { current.lines.push({ kind: 'del', text: line, old: oldNo++ }); oldLeft = Math.max(0, oldLeft - 1); continue }
      if (mark === ' ') {
        current.lines.push({ kind: 'context', text: line === '' ? ' ' : line, old: oldNo++, new: newNo++ })
        oldLeft = Math.max(0, oldLeft - 1); newLeft = Math.max(0, newLeft - 1)
        continue
      }
    }
    if (line === '') continue
    current.lines.push({ kind: kindOf(line), text: line })
  }
  return sections
}
