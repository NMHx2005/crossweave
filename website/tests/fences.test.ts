import { describe, expect, test } from 'bun:test'
import { scanFences } from '../src/fences'
import { lintMarkdown } from '../src/markdown'
import { sectionsOf, shiftHeadings } from '../src/readme'

const flags = (text: string): boolean[] => scanFences(text).map((l) => l.fenced)

describe('scanFences', () => {
  test('marks a block, fence lines included', () => {
    expect(flags('a\n```ts\nb\n```\nc')).toEqual([false, true, true, true, false])
  })

  test('a longer fence is closed only by an equally long one of the same character', () => {
    const text = '````md\n```\ninner\n```\n~~~\n````\nafter'
    expect(flags(text)).toEqual([true, true, true, true, true, true, false])
  })

  test('a tilde fence is not closed by backticks, and a closing fence takes no text after it', () => {
    expect(flags('~~~\n```\n~~~ x\n~~~\nz')).toEqual([true, true, true, true, false])
  })

  test('an unclosed fence runs to the end', () => {
    expect(flags('```\na\nb')).toEqual([true, true, true])
  })
})

describe('what relies on it', () => {
  const nested = 'before\n\n````md\n```\n## not a heading\n<div>raw</div>\n```\n````\n\n## Real heading\n\ntext'

  test('a section is not cut inside a longer fence, but ends at the next real heading after it', () => {
    const readme = `## Install\n\n${nested}\n\n## Next\n\nx`
    const body = sectionsOf(readme, ['Install'])['Install'] ?? ''
    expect(body).toContain('## not a heading')
    expect(body).toContain('<div>raw</div>')
    expect(body).not.toContain('Real heading')
  })

  test('headings inside such a fence are not shifted', () => {
    expect(shiftHeadings(nested, 1)).toContain('\n## not a heading\n')
    expect(shiftHeadings(nested, 1)).toContain('\n### Real heading')
  })

  test('raw HTML inside such a fence is not raw HTML', () => {
    expect(() => lintMarkdown(nested)).not.toThrow()
  })
})
