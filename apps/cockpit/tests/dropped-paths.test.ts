import { describe, expect, test } from 'bun:test'
import { droppedPathsText, escapeShellPath } from '../src/lib/dropped-paths'

describe('escapeShellPath', () => {
  test('backslash-escapes spaces, keeping non-ASCII letters as they are', () => {
    expect(escapeShellPath('/Users/nmh/Downloads/PROJECT CHÍP CHÍP KẾ HOẠCH.docx')).toBe(
      '/Users/nmh/Downloads/PROJECT\\ CHÍP\\ CHÍP\\ KẾ\\ HOẠCH.docx',
    )
  })

  test('escapes every shell metacharacter, backslash included', () => {
    expect(escapeShellPath('/a/(b)&c;d\'e"f$g`h*i?j[k]{l}<m>|n!o#p~q^r\\s')).toBe(
      '/a/\\(b\\)\\&c\\;d\\\'e\\"f\\$g\\`h\\*i\\?j\\[k\\]\\{l\\}\\<m\\>\\|n\\!o\\#p\\~q\\^r\\\\s',
    )
  })

  test('a plain path is unchanged', () => {
    expect(escapeShellPath('/Users/nmh/work/a-b_c.d/file.ts')).toBe('/Users/nmh/work/a-b_c.d/file.ts')
  })

  test('a newline or tab cannot run a command: it is neutralised, not passed through raw', () => {
    const out = escapeShellPath('/a/b\nc\td')
    expect(out).not.toContain('\n')
    expect(out).not.toContain('\t')
  })
})

describe('droppedPathsText', () => {
  test('several files: space-separated, one trailing space, like Ghostty and iTerm2', () => {
    expect(droppedPathsText(['/a b/c.txt', '/d.txt'])).toBe('/a\\ b/c.txt /d.txt ')
  })

  test('nothing droppable (empty, or files with no path): nothing to insert', () => {
    expect(droppedPathsText([])).toBe('')
    expect(droppedPathsText(['', ''])).toBe('')
  })

  test('skips an empty path among real ones', () => {
    expect(droppedPathsText(['', '/a.txt'])).toBe('/a.txt ')
  })
})
