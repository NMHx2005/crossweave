import type { BuiltPage } from './types'
import type { Lang } from './site'

export interface DocsSearchEntry {
  lang: Lang
  version: string
  title: string
  section: string
  href: string
  text: string
}

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function searchDocs(entries: readonly DocsSearchEntry[], query: string, version: string, limit = 30): DocsSearchEntry[] {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0 || !Number.isFinite(limit) || limit < 1) return []
  return entries.filter((entry) => {
    if (version !== 'all' && version !== entry.version) return false
    const haystack = normalizeSearchText(`${entry.title} ${entry.section} ${entry.text}`)
    return terms.every((term) => haystack.includes(term))
  }).slice(0, Math.floor(limit))
}

export function buildDocsSearchIndex(entries: readonly DocsSearchEntry[]): string {
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
  return `${JSON.stringify([...entries].sort((a, b) => compare(a.lang, b.lang) || compare(a.version, b.version) || compare(a.href, b.href)))}\n`
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function decodeHtml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (value) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[value] ?? value)
}

function textContent(fragment: string): string {
  return decodeHtml(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Derive section-level search targets from the exact article HTML written to the static page. */
export function docsSearchEntries(pages: readonly BuiltPage[]): DocsSearchEntry[] {
  const entries: DocsSearchEntry[] = []
  for (const page of pages) {
    const lang = page.meta.lang
    const body = String(page.body)
    const article = /<(?:article|div) class="(?:prose|wrap prose docs-version)"[^>]*>([\s\S]*?)<\/(?:article|div)>/.exec(body)?.[1]
      ?? /<article class="prose">([\s\S]*?)<\/article>/.exec(body)?.[1]
    if (article === undefined) continue
    const title = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(article)?.[1]
    if (title === undefined) continue
    const pageTitle = textContent(title)
    const content = article
      .replace(/<p class="docs__notice">[\s\S]*?<\/p>/, '')
      .replace(/<section class="docs-search"[\s\S]*?<\/section>/, '')
      .replace(/<nav class="docs-search__snapshots"[\s\S]*?<\/nav>/, '')
    const headingPattern = /<h([2-6]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g
    const headings = [...content.matchAll(headingPattern)]
    const firstHeading = headings[0]?.index ?? content.length
    const intro = textContent(content.slice(0, firstHeading))
    const archiveTag = /^\/docs\/versions\/(v\d+\.\d+\.\d+)\/$/.exec(page.path)?.[1]
    const version = archiveTag ?? 'current'
    if (intro !== '') entries.push({ lang, version, title: pageTitle, section: pageTitle, href: page.path, text: intro })
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]
      if (heading === undefined || heading.index === undefined) continue
      const afterHeading = heading.index + heading[0].length
      const nextHeading = headings[i + 1]?.index ?? content.length
      const section = textContent(heading[3] ?? '')
      const text = textContent(content.slice(afterHeading, nextHeading))
      entries.push({ lang, version, title: pageTitle, section, href: `${page.path}#${heading[2]}`, text })
    }
  }
  return entries
}
