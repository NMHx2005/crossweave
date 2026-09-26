export type FileLink = { start: number; end: number; path: string; line?: number; col?: number }

// A path with at least one `/` or a leading `./`, ending in a file extension, then an
// optional :line[:col]. Requiring a slash keeps prose like "done." and versions like
// "v2.1.283" from lighting up.
const LINK = /(?<![\w/:.-])((?:\.{1,2}\/|\/)?(?:[\w@+.-]+\/)+[\w@+.-]*\.[A-Za-z0-9]+|\.\/[\w@+.-]+\.[A-Za-z0-9]+)(?::(\d+)(?::(\d+))?)?/g

/** File references in one line of terminal text — the targets of Cmd+click. */
export function findFileLinks(text: string): FileLink[] {
  const out: FileLink[] = []
  for (const m of text.matchAll(LINK)) {
    const start = m.index ?? 0
    // Part of a URL (`scheme://host/...`): not a file on this disk.
    if (/[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(text.slice(0, start + 1))) continue
    const link: FileLink = { start, end: start + m[0].length, path: m[1]! }
    if (m[2] !== undefined) link.line = Number(m[2])
    if (m[3] !== undefined) link.col = Number(m[3])
    out.push(link)
  }
  return out
}
