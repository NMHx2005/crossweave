/** Helpers for the file and browser panes, kept pure so the rules are tested. */

export type Language = 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'json' | 'markdown' | 'css' | 'html' | 'python'

const BY_EXT: Record<string, Language> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'css', html: 'html', htm: 'html', py: 'python',
}

export function languageFor(path: string): Language | null {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * What the browser pane may load: http(s) only. `javascript:`, `file:` and `data:`
 * would turn a page into a way to run script in the app or read local files. A bare
 * host gets https, except localhost and IP addresses — dev servers — which get http.
 */
export function normalizeUrl(input: string): string | null {
  const text = input.trim()
  if (text === '') return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[\w.-]+:\d+/.test(text)
  const local = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(text)
  try {
    const url = new URL(hasScheme ? text : `${local ? 'http' : 'https'}://${text}`)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Files whose path contains `query`'s characters in order, ranked by a tight match
 * near the file name: fewer skipped characters first, then shorter paths.
 */
export function fuzzyFilter(files: readonly string[], query: string, limit: number): string[] {
  const q = query.toLowerCase()
  if (q === '') return files.slice(0, limit)
  const scored: Array<{ file: string; score: number }> = []
  for (const file of files) {
    const f = file.toLowerCase()
    let at = -1
    let gaps = 0
    let ok = true
    for (const ch of q) {
      const next = f.indexOf(ch, at + 1)
      if (next < 0) { ok = false; break }
      if (at >= 0) gaps += next - at - 1
      at = next
    }
    if (!ok) continue
    // A match inside the file name beats one spread across directories.
    const inName = f.lastIndexOf('/') < f.indexOf(q[0]!, f.lastIndexOf('/')) ? 0 : 5
    scored.push({ file, score: gaps + inName + file.length / 100 })
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.file)
}
