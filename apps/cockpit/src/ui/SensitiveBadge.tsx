/** @jsxImportSource preact */
import { SENSITIVE_LABEL, SENSITIVE_REASON, sensitiveKind, summarizeSensitive } from '../../../../src/core/sensitive-files.js'

/**
 * A word, not just a colour, beside a file the person should look at twice: judged by NAME only (see sensitive-files.ts).
 * The reason is on hover and also in the text a screen reader gets — a `title` alone reaches neither a keyboard nor a reader.
 */
export function SensitiveBadge({ path }: { path: string }) {
  const kind = sensitiveKind(path)
  if (kind === null) return null
  return (
    <span class={`cockpit-sensitive is-${kind}`} title={SENSITIVE_REASON[kind]}>
      {SENSITIVE_LABEL[kind]}
      <span class="cockpit-sr-only">{` — ${SENSITIVE_REASON[kind]}`}</span>
    </span>
  )
}

/** One line above a file list: how many, and of which kinds (the kinds that make Land ask come first). */
export function SensitiveSummary({ paths }: { paths: readonly string[] }) {
  const { total, byKind } = summarizeSensitive(paths)
  if (total === 0) return null
  return (
    <p class="cockpit-muted cockpit-changes__note">
      {`${total} sensitive file${total === 1 ? '' : 's'}: ${byKind.map((g) => `${g.paths.length} ${SENSITIVE_LABEL[g.kind]}`).join(' · ')}`}
    </p>
  )
}
