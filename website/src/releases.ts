import { compareTags } from './release'
import type { Release } from './types'

/** Markdown reduced to the words a reader sees: links keep their text, emphasis and code marks go. */
function plain(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first sentence of the paragraph under `## Headline`, as plain text; empty when a release note has none. */
export function headlineOf(markdown: string, heading = 'Headline'): string {
  const lines = markdown.split('\n')
  const at = lines.findIndex((l) => l === `## ${heading}`)
  if (at < 0) return ''
  const paragraph: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (/^#{1,6}\s/.test(line)) break
    paragraph.push(line)
  }
  const text = plain(paragraph.join(' '))
  // A sentence ends at a full stop followed by a capital or the end: "0.5.0 gives" does not end at its dots.
  return /^(.+?[.!?])(?=\s+["“(A-Z]|$)/.exec(text)?.[1] ?? text
}

export interface ReleaseEntry {
  tag: string
  date: string | null
  headline: string
}

/** The latest published releases, newest first by semantic version: nothing above the manifest's tag has been published. */
export function recentReleases(notes: ReadonlyArray<{ tag: string; markdown: string }>, release: Release, limit: number, heading = 'Headline'): ReleaseEntry[] {
  return notes
    .filter((n) => compareTags(n.tag, release.tag) <= 0)
    .sort((a, b) => compareTags(b.tag, a.tag))
    .slice(0, limit)
    .map((n) => ({ tag: n.tag, date: release.dates?.[n.tag] ?? null, headline: headlineOf(n.markdown, heading) }))
}

/** The newest release note above the latest published release, if any: what is being prepared. */
export function inDevelopment(notes: ReadonlyArray<{ tag: string }>, release: Release): string | null {
  const newer = notes.map((n) => n.tag).filter((tag) => compareTags(tag, release.tag) > 0).sort((a, b) => compareTags(b, a))
  return newer[0] ?? null
}
