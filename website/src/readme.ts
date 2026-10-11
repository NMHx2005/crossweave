import { scanFences as lines } from './fences'

/**
 * Pieces of the README for the docs pages. A section runs from its `## ` heading to the next one; a `## ` inside a code fence is not a
 * heading. Asking for a section that is not there throws, so a renamed heading breaks the build instead of thinning the docs.
 */
export function sectionsOf(readme: string, wanted: readonly string[]): Record<string, string> {
  const rows = lines(readme)
  const out: Record<string, string> = {}
  for (const name of wanted) {
    const start = rows.findIndex((r) => !r.fenced && r.line === `## ${name}`)
    if (start < 0) throw new Error(`README.md has no "## ${name}" section (the website's docs are built from it)`)
    let end = rows.findIndex((r, i) => i > start && !r.fenced && /^## /.test(r.line))
    if (end < 0) end = rows.length
    out[name] = rows.slice(start + 1, end).map((r) => r.line).join('\n').trim()
  }
  return out
}

/** Moves every heading outside code fences by `delta` levels (clamped to h1…h6). */
export function shiftHeadings(markdown: string, delta: number): string {
  return lines(markdown)
    .map(({ line, fenced }) => {
      const m = /^(#{1,6})(\s.*)$/.exec(line)
      if (fenced || m === null) return line
      const level = Math.min(6, Math.max(1, (m[1] ?? '').length + delta))
      return `${'#'.repeat(level)}${m[2]}`
    })
    .join('\n')
}

const tagsToMarkdown = (text: string): string =>
  text.replace(/<code>(.*?)<\/code>/g, '`$1`').replace(/<\/?(sub|sup|strong|em|b|i)>/g, '').replace(/<[^>]+>/g, '')

/**
 * The README draws its screenshots with a centred `<p><img>` and a `<sub>` caption. Those become markdown images and plain text; the
 * images keep their repository path, which the docs build maps to the site's own copy.
 */
export function prepareReadmeMarkdown(section: string): string {
  return lines(section)
    .map(({ line, fenced }) => {
      if (fenced) return line
      const para = /^\s*<p align="center">(.*)<\/p>\s*$/.exec(line)
      if (para === null) return line
      const inner = para[1] ?? ''
      const images = [...inner.matchAll(/<img\s+[^>]*>/g)].map((m) => m[0])
      if (images.length === 0) return tagsToMarkdown(inner)
      return images
        .map((tag) => {
          const src = /\ssrc="([^"]*)"/.exec(tag)?.[1] ?? ''
          const alt = (/\salt="([^"]*)"/.exec(tag)?.[1] ?? '').replace(/[[\]]/g, '')
          return `![${alt}](${src})`
        })
        .join('\n\n')
    })
    .join('\n')
}
