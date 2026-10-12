import { compareTags } from './release'
import type { Release } from './types'

/** Fail the static build when a translated release note is missing or has no English counterpart. */
export function assertReleaseTagParity(
  english: ReadonlyArray<{ tag: string }>,
  vietnamese: ReadonlyArray<{ tag: string }>,
): void {
  const enTags = [...new Set(english.map((note) => note.tag))].sort()
  const viTags = [...new Set(vietnamese.map((note) => note.tag))].sort()
  const missing = enTags.filter((tag) => !viTags.includes(tag))
  const extra = viTags.filter((tag) => !enTags.includes(tag))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Vietnamese release note tags differ from English (missing Vietnamese: ${missing.join(', ') || 'none'}; extra Vietnamese: ${extra.join(', ') || 'none'})`)
  }
}

/** Markdown reduced to the words a reader sees: links keep their text, emphasis and code marks go. */
function plain(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first sentence under the locale's summary heading, as plain text; empty when a release note has none. */
export function headlineOf(markdown: string, heading = 'Headline'): string {
  const lines = markdown.split('\n')
  const at = lines.findIndex((line) => /^##\s+/.test(line) && line.replace(/^##\s+/, '').trim() === heading)
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
  return /^(.+?[.!?])(?=\s+["“(]|\s+\p{Lu}|$)/u.exec(text)?.[1] ?? text
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
