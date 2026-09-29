/** Time source, injected so the committer is deterministic under test. */
export interface CommitClock {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

const REAL_CLOCK: CommitClock = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface CommitterOptions<T> {
  /** Resolves to null when saved, or the daemon's sentence when it refused. */
  save: (value: T) => Promise<string | null>
  /** Called after every save attempt with the value tried and the problem, if any. */
  onResult: (value: T, problem: string | null) => void
  delayMs?: number
  clock?: CommitClock
}

export interface Committer<T> {
  /** Save this value after the delay; a newer call restarts the wait. */
  schedule(value: T): void
  /** Save a pending value now (closing the page), and wait for it. */
  flush(): Promise<void>
  /** Forget a pending value (discarding a draft). */
  cancel(): void
}

/**
 * Commit-on-change for a page of independent controls that all write one settings
 * object. Typing coalesces behind a short delay; at most one save is in flight, and a
 * change made during it is saved right after (latest wins) — the daemon writes the whole
 * object, so two concurrent saves could land out of order and lose the newer one.
 */
export function createCommitter<T>(opts: CommitterOptions<T>): Committer<T> {
  const delay = opts.delayMs ?? 500
  const clock = opts.clock ?? REAL_CLOCK
  let pending: { value: T } | undefined
  let timer: unknown
  let running: Promise<void> | undefined

  const run = (): Promise<void> => {
    if (running !== undefined) return running
    running = (async () => {
      while (pending !== undefined) {
        const { value } = pending
        pending = undefined
        let problem: string | null
        try {
          problem = await opts.save(value)
        } catch (err) {
          problem = err instanceof Error ? err.message : String(err)
        }
        opts.onResult(value, problem)
      }
    })().finally(() => { running = undefined })
    return running
  }

  return {
    schedule(value) {
      pending = { value }
      if (timer !== undefined) clock.clearTimer(timer)
      timer = clock.setTimer(() => {
        timer = undefined
        void run()
      }, delay)
    },
    async flush() {
      if (timer !== undefined) {
        clock.clearTimer(timer)
        timer = undefined
      }
      await run()
      // `run` resolves when the queue drains; a save in flight when flush was called
      // (with nothing newer pending) is what it awaits.
      if (running !== undefined) await running
    },
    cancel() {
      pending = undefined
      if (timer !== undefined) {
        clock.clearTimer(timer)
        timer = undefined
      }
    },
  }
}
