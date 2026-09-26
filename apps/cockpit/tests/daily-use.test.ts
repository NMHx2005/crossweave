import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextAttentionSession } from '../src/lib/attention-jump'
import { findFileLinks } from '../src/lib/file-links'
import { suggestSessionName, sessionNameError } from '../src/lib/quick-picker'
import { editorLaunch, resolveLinkTarget } from '../electron/editor-open'

describe('nextAttentionSession (⌘⇧A)', () => {
  const order = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  test('picks the most urgent: a conflict, then work ready to land', () => {
    expect(nextAttentionSession(order, { a: 'working', b: 'ready', c: 'conflict', d: 'unknown' }, null)).toBe('c')
    expect(nextAttentionSession(order, { a: 'ready', b: 'working' }, null)).toBe('a')
  })
  test('pressing again cycles through sessions of the same urgency', () => {
    const att = { a: 'conflict', b: 'working', c: 'conflict', d: 'conflict' } as const
    expect(nextAttentionSession(order, att, 'a')).toBe('c')
    expect(nextAttentionSession(order, att, 'c')).toBe('d')
    expect(nextAttentionSession(order, att, 'd')).toBe('a')
  })
  test('nothing needs you: null', () => {
    expect(nextAttentionSession(order, { a: 'working', b: 'unknown' }, 'a')).toBeNull()
  })
})

describe('findFileLinks (Cmd+click)', () => {
  test('finds relative and absolute paths with an optional line and column', () => {
    const text = 'error in src/core/paths.ts:112:7 and ./README.md then /abs/x.tsx:3'
    const links = findFileLinks(text)
    expect(links.map((l) => [l.path, l.line, l.col])).toEqual([
      ['src/core/paths.ts', 112, 7], ['./README.md', undefined, undefined], ['/abs/x.tsx', 3, undefined],
    ])
    expect(text.slice(links[0]!.start, links[0]!.end)).toBe('src/core/paths.ts:112:7')
  })
  test('ignores URLs, bare words and version numbers', () => {
    expect(findFileLinks('see https://example.com/a/b.html and v2.1.283 and done.')).toEqual([])
  })
})

describe('quick picker names', () => {
  test('suggests the first free <prefix>-n name', () => {
    expect(suggestSessionName('codex', ['codex-1', 'codex-2', 'claude-1'])).toBe('codex-3')
    expect(suggestSessionName('claude', [])).toBe('claude-1')
  })
  test('checks a name the way the daemon does', () => {
    expect(sessionNameError('ok_name-2')).toBeNull()
    expect(sessionNameError('')).toMatch(/name/i)
    expect(sessionNameError('bad name!')).toMatch(/letters/i)
  })
})

describe('editor links', () => {
  test('opens VS Code, Cursor and Zed through their URL schemes at line:col', () => {
    expect(editorLaunch({ kind: 'vscode' }, '/r/a b.ts', 12, 3)).toEqual({ kind: 'url', url: 'vscode://file/r/a%20b.ts:12:3' })
    expect(editorLaunch({ kind: 'cursor' }, '/r/x.ts', 4)).toEqual({ kind: 'url', url: 'cursor://file/r/x.ts:4:1' })
    expect(editorLaunch({ kind: 'zed' }, '/r/x.ts')).toEqual({ kind: 'url', url: 'zed://file/r/x.ts:1:1' })
  })
  test('a custom editor gets argv with {file} {line} {col} filled, never a shell string', () => {
    expect(editorLaunch({ kind: 'custom', command: 'subl "{file}:{line}:{col}"' }, '/r/x; touch pwned.ts', 2, 5))
      .toEqual({ kind: 'exec', argv: ['subl', '/r/x; touch pwned.ts:2:5'] })
  })

  // An agent prints whatever it likes; a link may only open a file inside its worktree.
  test('resolves a link against the worktree and refuses anything outside it', () => {
    const wt = realpathSync(mkdtempSync(join(tmpdir(), 'cw-links-')))
    try {
      mkdirSync(join(wt, 'src'))
      writeFileSync(join(wt, 'src', 'a.ts'), '')
      expect(resolveLinkTarget(wt, 'src/a.ts')).toBe(join(wt, 'src', 'a.ts'))
      expect(resolveLinkTarget(wt, join(wt, 'src', 'a.ts'))).toBe(join(wt, 'src', 'a.ts'))
      expect(resolveLinkTarget(wt, '../../etc/passwd')).toBeNull()
      expect(resolveLinkTarget(wt, '/etc/passwd')).toBeNull()
      expect(resolveLinkTarget(wt, 'src/missing.ts')).toBeNull()
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })
})
