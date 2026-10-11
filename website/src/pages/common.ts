import { REPO_URL, escapeHtml } from '../site'

export const esc = escapeHtml

/** A file of this repository on GitHub, for a limitations file or a README link the site does not host itself. */
export function repoFile(path: string): string {
  const clean = path.replace(/^\.?\//, '')
  return `${REPO_URL}/${clean.endsWith('/') ? 'tree' : 'blob'}/main/${clean}`
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-09-30` as `30 Sep 2026` (or `30 thg 9, 2026`): written out by hand, so the output never depends on the ICU data of the machine that builds. */
export function formatDay(day: string, lang: 'en' | 'vi'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return day
  const [year, month, date] = [m[1], Number(m[2]), Number(m[3])]
  return lang === 'vi' ? `${date} thg ${month}, ${year}` : `${date} ${MONTHS_EN[month - 1] ?? ''} ${year}`
}

/** A sentence cut at a word boundary, with an ellipsis, for a strip of releases. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max).replace(/\s+\S*$/, '')
  return `${cut}…`
}

/** The changelog's own anchor for a release (`v0.6.0` is `#v0-6-0`). */
export const releaseAnchor = (tag: string): string => tag.replace(/\./g, '-')
