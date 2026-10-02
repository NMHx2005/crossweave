import type { BrowserErrorRow } from '../../../../src/core/browser-agent/errors.js'

/**
 * The session's debug bundle (`session.debug` RPC), as the Debug pane reads it, and
 * the small pure pieces of its presentation: the check line, and the text "Send to
 * session" carries. Scrubbing happens in the daemon — this surface shows the bundle.
 * Its browser half comes separately, from main (`browser.errors`).
 *
 * The shape mirrors the CLI's `DebugBundle` (`src/cli/commands/debug.ts`) by design:
 * two processes, two copies. Keep them in step when a field changes.
 */

export interface DebugBundle {
  session: { id: string; name: string; status: string; branch: string | null; worktreePath: string | null }
  agent: string | null
  activity: string
  lastActivityAt: number | null
  check?: {
    state: 'running' | 'pass' | 'fail'
    ms?: number
    code?: number
    tail?: string
    stale?: boolean
  }
  errors: Array<{ at: number; line: string }>
  diff: {
    files: Array<{ path: string; status: string; added: number; deleted: number }>
    total: number
    uncommitted: number
  }
  latestWords?: string
}

/** The check verdict as one labelled line (the rail's chip, expanded). */
export function debugCheckLine(c: NonNullable<DebugBundle['check']>): string {
  const took = c.ms === undefined ? '' : ` (${(c.ms / 1000).toFixed(1)}s)`
  const stale = c.stale === true ? ', stale' : ''
  if (c.state === 'fail') return `FAIL (exit ${c.code ?? '?'}${took}${stale})`
  return `${c.state}${took}${stale}`
}

/**
 * What "Send to session" carries: the failing tail, else the session's error lines,
 * else the browser's errors, else nothing (the button is not offered). A prompt is the
 * person's; the app only drafts this text into the composer, where the exact preview
 * still shows.
 */
export function sendableText(b: DebugBundle, browserErrors: readonly BrowserErrorRow[] = []): string | undefined {
  if (b.check?.tail !== undefined && b.check.tail.trim() !== '') return b.check.tail.trim()
  if (b.errors.length > 0) return b.errors.map((e) => e.line).join('\n')
  if (browserErrors.length > 0) return browserErrors.map((e) => e.text).join('\n')
  return undefined
}
