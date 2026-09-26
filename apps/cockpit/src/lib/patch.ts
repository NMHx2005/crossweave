/** `session.diff`'s answer: what landing the session would bring in. */
export type SessionDiff = {
  files: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; added: number; deleted: number }>
  patch: string
  truncated: boolean
  /** Files changed in the worktree but not committed; landing does not take them. */
  uncommitted: number
}

/** One file's part of a unified diff, for rendering and for jumping to it. */
export type PatchSection = { path: string; lines: PatchLine[] }
export type PatchLine = { kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'; text: string }

function kindOf(line: string): PatchLine['kind'] {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')
    || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('Binary files')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

/**
 * `git diff` output split per file. The path comes from the `diff --git a/x b/x`
 * header's b-side (the diff is --no-renames, so both sides name the same file).
 */
export function patchSections(patch: string): PatchSection[] {
  const sections: PatchSection[] = []
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line)
    if (header) {
      sections.push({ path: header[1] ?? '', lines: [] })
      continue
    }
    const current = sections.at(-1)
    if (current === undefined || line === '') continue
    current.lines.push({ kind: kindOf(line), text: line })
  }
  return sections
}
