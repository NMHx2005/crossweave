import { REPO_URL, escapeHtml } from '../site'

export const esc = escapeHtml

/** A file of this repository on GitHub, for a limitations file or a README link the site does not host itself. */
export function repoFile(path: string): string {
  const clean = path.replace(/^\.?\//, '')
  return `${REPO_URL}/${clean.endsWith('/') ? 'tree' : 'blob'}/main/${clean}`
}
