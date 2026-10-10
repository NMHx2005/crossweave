import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchSections } from '../src/lib/patch'

const PATCH = [
  'diff --git a/keep.txt b/keep.txt',
  'index 1..2 100644',
  '--- a/keep.txt',
  '+++ b/keep.txt',
  '@@ -1,2 +1,2 @@',
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
    expect(sections[1]!.lines.at(-1)).toEqual({ kind: 'add', text: '+export const x = 1;', new: 1 })
  })

  test('an empty patch has no sections', () => {
    expect(patchSections('')).toEqual([])
  })
})

describe('patchSections numbering', () => {
  const P = [
    'diff --git a/a.sql b/a.sql', 'index 1..2 100644', '--- a/a.sql', '+++ b/a.sql',
    '@@ -10,3 +10,3 @@ ctx',
    ' keep', '--- a sql comment', '+++ replacement', ' tail',
    '@@ -30 +30,2 @@',
    '-gone', '+one', '+two', '\\ No newline at end of file',
    'diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt',
    '@@ -0,0 +1,2 @@', '+x', '+y', '',
  ].join('\n')

  test('numbers lines from hunk headers; content that looks like ---/+++ is still a del/add', () => {
    const [a, n] = patchSections(P)
    const body = a!.lines.filter((l) => l.kind !== 'meta' && l.kind !== 'hunk')
    expect(body.map((l) => [l.kind, l.old, l.new])).toEqual([
      ['context', 10, 10], ['del', 11, undefined], ['add', undefined, 11], ['context', 12, 12],
      ['del', 30, undefined], ['add', undefined, 30], ['add', undefined, 31],
    ])
    expect(a!.lines.at(-1)).toEqual({ kind: 'meta', text: '\\ No newline at end of file' })
    expect(n!.lines.filter((l) => l.kind === 'add').map((l) => l.new)).toEqual([1, 2])
  })

  test('file headers before the first hunk stay meta and carry no number', () => {
    const [a] = patchSections(P)
    expect(a!.lines.slice(0, 3).every((l) => l.kind === 'meta' && l.old === undefined && l.new === undefined)).toBe(true)
  })

  test('a header or hunk is never swallowed, even when the counts disagree with the body', () => {
    const lying = ['diff --git a/x b/x', '@@ -1,9 +1,9 @@', ' a', '@@ -50 +50 @@', '-b', '+c', 'diff --git a/y b/y', '@@ -1 +1 @@', '-p', '+q', ''].join('\n')
    const sections = patchSections(lying)
    expect(sections.map((s) => s.path)).toEqual(['x', 'y'])
    expect(sections[0]!.lines.filter((l) => l.kind === 'del').map((l) => l.old)).toEqual([50])
  })

  test('a blank context line that arrives as an empty string still counts', () => {
    const [s] = patchSections(['diff --git a/x b/x', '@@ -1,3 +1,3 @@', ' a', '', ' c', ''].join('\n'))
    expect(s!.lines.filter((l) => l.kind === 'context').map((l) => [l.old, l.new])).toEqual([[1, 1], [2, 2], [3, 3]])
  })

  test('a patch cut mid-hunk keeps exact numbers for what is there and does not throw', () => {
    const cut = P.slice(0, P.indexOf('+++ replacement') + 6)
    const [a] = patchSections(cut)
    expect(a!.lines.at(-1)?.new).toBe(11)
  })

  test('an omitted count means one line', () => {
    const [s] = patchSections(['diff --git a/x b/x', '@@ -3 +3 @@', '-a', '+b', ''].join('\n'))
    expect(s!.lines.map((l) => [l.kind, l.old, l.new])).toEqual([['hunk', undefined, undefined], ['del', 3, undefined], ['add', undefined, 3]])
  })

  test('a binary file and a mode-only change are sections without numbered lines', () => {
    const sections = patchSections(['diff --git a/b.bin b/b.bin', 'index 1..2 100644', 'Binary files a/b.bin and b/b.bin differ',
      'diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n'))
    expect(sections.map((s) => s.path)).toEqual(['b.bin', 'run.sh'])
    expect(sections.flatMap((s) => s.lines).every((l) => l.kind === 'meta' && l.new === undefined && l.old === undefined)).toBe(true)
  })
})

describe('patchSections paths', () => {
  test('a path containing " b/" is whole, not cut at its last "b/"', () => {
    const [s] = patchSections('diff --git a/dir b/f.txt b/dir b/f.txt\n@@ -1 +1 @@\n-a\n+b\n')
    expect(s!.path).toBe('dir b/f.txt')
  })
  test('a quoted header (core.quotePath) is unquoted, UTF-8 octal escapes included', () => {
    const [s] = patchSections('diff --git "a/\\303\\251 \\303\\274.txt" "b/\\303\\251 \\303\\274.txt"\n@@ -1 +1 @@\n-a\n+b\n')
    expect(s!.path).toBe('é ü.txt')
  })
  test('a different diff prefix (diff.mnemonicPrefix) still gives the path', () => {
    const [s] = patchSections('diff --git i/src/a.ts w/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n')
    expect(s!.path).toBe('src/a.ts')
  })
})

describe('patchSections against real git output', () => {
  test('every numbered line points at the same text in the file it names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-patch-'))
    const git = (...args: string[]): string => {
      const r = spawnSync('git', ['-C', dir, '-c', 'core.quotePath=true', '-c', 'diff.suppressBlankEmpty=true', ...args], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
      return r.stdout
    }
    const files: Record<string, [string, string]> = {
      'a.sql': ['select 1;\n-- one\n\nfrom t;\n', 'select 1;\n++ two\n\nfrom t2;\n-- three\n'],
      'é ü.txt': ['alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma'],
      'dir b/f.txt': ['x\n', 'y\n'],
      'n.txt': ['1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', '1\n2\n3\n4\nfive\n6\n7\n8\n9\nten\n'],
    }
    try {
      git('init', '-q')
      mkdirSync(join(dir, 'dir b'))
      for (const [name, [before]] of Object.entries(files)) writeFileSync(join(dir, name), before)
      git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one')
      for (const [name, [, after]] of Object.entries(files)) writeFileSync(join(dir, name), after)
      const sections = patchSections(git('diff', '--no-renames', '--no-color'))
      expect(sections.map((s) => s.path).sort()).toEqual(Object.keys(files).sort())
      let checked = 0
      for (const section of sections) {
        const [before, after] = files[section.path]!
        for (const line of section.lines) {
          if (line.kind === 'add') { expect(after.split('\n')[line.new! - 1]).toBe(line.text.slice(1)); checked++ }
          if (line.kind === 'del') { expect(before.split('\n')[line.old! - 1]).toBe(line.text.slice(1)); checked++ }
          if (line.kind === 'context') { expect(after.split('\n')[line.new! - 1]).toBe(line.text.slice(1)); expect(before.split('\n')[line.old! - 1]).toBe(line.text.slice(1)); checked++ }
        }
      }
      expect(checked).toBeGreaterThan(15)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
