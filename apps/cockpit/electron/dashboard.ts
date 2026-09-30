export interface AppMetric { type: string; memoryKb: number; cpu: number }

export interface DashboardDeps {
  /** The projects open in this window. */
  roots: () => Promise<string[]>
  /** One project's `stats.overview`, asked through the bridge. */
  overview: (root: string) => Promise<unknown>
  /** Electron's per-process figures (`app.getAppMetrics()`), already reduced to what is needed. */
  metrics: () => AppMetric[]
  now?: () => number
  /** How long one project may take before it is reported as not answering. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
/** Projects asked at once: enough to be quick, few enough not to open a burst of daemon connections. */
const CONCURRENCY = 8

const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path
const finiteNonNegative = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/** An old daemon says "Unknown method"; the client turns that into METHOD_NOT_FOUND, but the words are checked too. */
function isMissingMethod(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  if (code === 'METHOD_NOT_FOUND') return true
  const message = err instanceof Error ? err.message : String(err)
  return /unknown method/i.test(message)
}

/** The code of a CrossweaveError, if the error has one: the only part of a failure that is safe to show. */
function safeCode(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,39}$/.test(code) ? code : undefined
}

type Entry =
  | { root: string; name: string; state: 'ok'; overview: unknown }
  | { root: string; name: string; state: 'needs-restart' }
  | { root: string; name: string; state: 'unreachable'; message: string }

/**
 * The dashboard's data, gathered in the main process: every open project's `stats.overview`, and the app's own memory and CPU.
 * It never throws: a daemon that is old, silent or failing becomes an entry that says so (and, for a failure, shows only its error
 * CODE — a message from a daemon can carry a path or worse), so one bad project cannot blank the page.
 */
export async function collectDashboard(deps: DashboardDeps): Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let roots: string[] = []
  try {
    roots = await deps.roots()
  } catch {
    roots = []
  }

  const ask = async (root: string): Promise<Entry> => {
    const name = baseName(root)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const overview = await Promise.race([
        deps.overview(root),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { timedOut: true })), timeoutMs) }),
      ])
      return { root, name, state: 'ok', overview }
    } catch (err) {
      if ((err as { timedOut?: boolean } | null)?.timedOut === true) return { root, name, state: 'unreachable', message: `The daemon did not answer within ${Math.round(timeoutMs / 1000)} s.` }
      if (isMissingMethod(err)) return { root, name, state: 'needs-restart' }
      const code = safeCode(err)
      return { root, name, state: 'unreachable', message: code === undefined ? 'The daemon could not be read.' : `The daemon could not be read (${code}).` }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const projects: Entry[] = new Array(roots.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, roots.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= roots.length) return
      projects[i] = await ask(roots[i] as string)
    }
  }))

  let app: { memoryBytes: number; cpuPercent: number; processes: number } | null = null
  try {
    const metrics = deps.metrics()
    app = {
      memoryBytes: metrics.reduce((sum, m) => sum + finiteNonNegative(m.memoryKb) * 1024, 0),
      cpuPercent: Math.round(metrics.reduce((sum, m) => sum + finiteNonNegative(m.cpu), 0) * 10) / 10,
      processes: metrics.length,
    }
  } catch {
    app = null
  }

  return { projects, app, at: deps.now?.() ?? Date.now() }
}
