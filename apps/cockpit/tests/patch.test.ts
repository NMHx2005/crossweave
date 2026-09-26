import { describe, expect, test } from 'bun:test'
import { patchSections } from '../src/lib/patch'

const PATCH = [
  'diff --git a/keep.txt b/keep.txt',
  'index 1..2 100644',
  '--- a/keep.txt',
  '+++ b/keep.txt',
  '@@ -1,2 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  'diff --git a/src/new file.ts b/src/new file.ts',
  'new file mode 100644',
  '@@ -0,0 +1 @@',
  '+export const x = 1;',
  '',
].join('\n')

describe('patchSections', () => {
  test('splits per file and classifies each line; ---/+++ are headers, not edits', () => {
    const sections = patchSections(PATCH)
    expect(sections.map((s) => s.path)).toEqual(['keep.txt', 'src/new file.ts'])
    expect(sections[0]!.lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add'])
    expect(sections[1]!.lines.at(-1)).toEqual({ kind: 'add', text: '+export const x = 1;' })
  })

  test('an empty patch has no sections', () => {
    expect(patchSections('')).toEqual([])
  })
})
