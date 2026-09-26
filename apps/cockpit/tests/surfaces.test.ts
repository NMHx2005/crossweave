import { describe, expect, test } from 'bun:test'
import { fuzzyFilter, languageFor, normalizeUrl } from '../src/lib/surfaces'

describe('languageFor', () => {
  test('maps common extensions to a highlighter', () => {
    expect(languageFor('src/a.ts')).toBe('typescript')
    expect(languageFor('App.tsx')).toBe('tsx')
    expect(languageFor('x.mjs')).toBe('javascript')
    expect(languageFor('package.json')).toBe('json')
    expect(languageFor('README.md')).toBe('markdown')
    expect(languageFor('s.css')).toBe('css')
    expect(languageFor('i.html')).toBe('html')
    expect(languageFor('m.py')).toBe('python')
    expect(languageFor('Makefile')).toBeNull()
  })
})

describe('normalizeUrl (browser pane)', () => {
  test('adds a scheme: http for localhost and IPs, https otherwise', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeUrl('127.0.0.1:43000/api')).toBe('http://127.0.0.1:43000/api')
    expect(normalizeUrl('example.com')).toBe('https://example.com/')
    expect(normalizeUrl('https://docs.x.dev/a?b=1')).toBe('https://docs.x.dev/a?b=1')
  })

  // The pane is a web page, not a way to run script in the app or read local files.
  test('refuses every scheme but http and https', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeUrl('data:text/html,hi')).toBeNull()
    expect(normalizeUrl('')).toBeNull()
  })
})

describe('fuzzyFilter (quick open)', () => {
  const files = ['src/core/paths.ts', 'src/cli/index.ts', 'README.md', 'tests/core/paths.test.ts', 'docs/paths.md']
  test('matches characters in order, best (shortest, earliest) first', () => {
    expect(fuzzyFilter(files, 'paths', 3)).toEqual(['docs/paths.md', 'src/core/paths.ts', 'tests/core/paths.test.ts'])
    expect(fuzzyFilter(files, 'scix', 5)).toEqual(['src/cli/index.ts'])
  })
  test('an empty query lists the first files', () => {
    expect(fuzzyFilter(files, '', 2)).toEqual(['src/core/paths.ts', 'src/cli/index.ts'])
  })
})
