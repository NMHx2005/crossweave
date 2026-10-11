import { describe, expect, test } from 'bun:test'
import { escapeHtml, loadConfig, makeUrls } from '../src/site'

describe('loadConfig', () => {
  test('defaults to the project site on GitHub Pages', () => {
    expect(loadConfig({})).toEqual({ origin: 'https://nmhx2005.github.io', base: '/crossweave', domain: null })
  })

  test('a custom domain moves the site to its root', () => {
    expect(loadConfig({ SITE_DOMAIN: 'crossweave.dev' })).toEqual({ origin: 'https://crossweave.dev', base: '', domain: 'crossweave.dev' })
  })

  test('an empty SITE_BASE means the site root, and a base is normalised', () => {
    expect(loadConfig({ SITE_BASE: '' }).base).toBe('')
    expect(loadConfig({ SITE_BASE: 'x/' }).base).toBe('/x')
    expect(loadConfig({ SITE_BASE: '/x/y//' }).base).toBe('/x/y')
    expect(loadConfig({ SITE_URL: 'https://example.org/' }).origin).toBe('https://example.org')
  })
})

describe('makeUrls', () => {
  const project = makeUrls(loadConfig({}))
  const root = makeUrls(loadConfig({ SITE_DOMAIN: 'crossweave.dev' }))

  test('a path carries the base, an absolute URL carries the origin too', () => {
    expect(project.path('/docs/')).toBe('/crossweave/docs/')
    expect(project.path('/')).toBe('/crossweave/')
    expect(project.abs('/docs/')).toBe('https://nmhx2005.github.io/crossweave/docs/')
  })

  test('on a custom domain nothing is prefixed', () => {
    expect(root.path('/vi/')).toBe('/vi/')
    expect(root.path('/')).toBe('/')
    expect(root.abs('/vi/')).toBe('https://crossweave.dev/vi/')
  })

  test('a path that does not start with a slash is a bug, not something to guess at', () => {
    expect(() => project.path('docs/')).toThrow()
    expect(() => project.abs('')).toThrow()
  })
})

describe('escapeHtml', () => {
  test('escapes the five characters that matter in text and in attributes', () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;')
  })

  test('escaping twice double-escapes: the contract is that a leaf is escaped exactly once', () => {
    expect(escapeHtml(escapeHtml('<'))).toBe('&amp;lt;')
  })
})
