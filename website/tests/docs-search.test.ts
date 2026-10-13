import { describe, expect, test } from 'bun:test'
import { buildDocsSearchIndex, searchDocs, type DocsSearchEntry } from '../src/docs-search'

const current: DocsSearchEntry = { lang: 'en', version: 'main', title: 'Configuration', section: 'Named ports', href: '/docs/configuration/#named-ports', text: 'Reserve a port for each session.' }
const archived: DocsSearchEntry = { lang: 'en', version: 'v0.6.0', title: 'Crossweave', section: 'Worktrees', href: '/docs/versions/v0.6.0/#worktrees', text: 'A repository can have isolated worktrees.' }
const vietnamese: DocsSearchEntry = { lang: 'vi', version: 'main', title: 'Cấu hình', section: 'Cổng có tên', href: '/vi/docs/configuration/#named-ports', text: 'Mỗi phiên có cổng riêng.' }
const entries = [current, archived, vietnamese]

describe('the static Docs search index', () => {
  test('normalizes accents and case, and requires every term across title, section and text', () => {
    expect(searchDocs(entries, '  CỔNG   rieng ', 'all')).toEqual([vietnamese])
    expect(searchDocs(entries, 'PORT session', 'main')).toEqual([current])
    expect(searchDocs(entries, 'isolated worktrees', 'v0.6.0')).toEqual([archived])
  })

  test('keeps deterministic source order, caps results, and handles empty or unmatched queries', () => {
    expect(searchDocs(entries, 'session', 'all', 1)).toEqual([current])
    expect(searchDocs(entries, '   ', 'all')).toEqual([])
    expect(searchDocs(entries, 'nothing matches', 'all')).toEqual([])
    expect(buildDocsSearchIndex(entries)).toBe(buildDocsSearchIndex(entries))
    expect(buildDocsSearchIndex(entries)).not.toContain('</script>')
  })
})
