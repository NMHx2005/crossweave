export type ConvergeStatus = {
  ready: string[]
  unknown: { name: string; reason: string }[]
  blocked: { name: string; reason: string }[]
}

export type LandResult = {
  status: 'landed'
  tested: 'clean' | 'unverified'
  baseBranch: string
  warnings: string[]
}

export type LandSelectedResult = 'landed' | 'blocked' | 'needs_confirm_unknown' | 'failed'

/**
 * Evidence-gated land of one named session. Blocked never lands.
 * Unknown lands only with forceUnknown (UI confirm). Ready lands without force.
 */
export async function landSelected(opts: {
  getStatus: () => Promise<ConvergeStatus>
  land: (name: string, force?: boolean) => Promise<LandResult>
  name: string
  forceUnknown?: boolean
}): Promise<LandSelectedResult> {
  let status: ConvergeStatus
  try {
    status = await opts.getStatus()
  } catch {
    return 'failed'
  }

  if (status.blocked.some((entry) => entry.name === opts.name)) return 'blocked'
  const unknown = status.unknown.some((entry) => entry.name === opts.name)
  if (unknown && !opts.forceUnknown) return 'needs_confirm_unknown'
  const ready = status.ready.includes(opts.name)
  if (!ready && !unknown) return 'failed'

  try {
    await opts.land(opts.name, unknown ? true : false)
    return 'landed'
  } catch {
    return 'failed'
  }
}

/**
 * Same re-fetch loop as `cw land all` without --force: only `ready`, stop on first failure.
 */
export async function landAllReady(opts: {
  getStatus: () => Promise<ConvergeStatus>
  land: (name: string) => Promise<LandResult>
  onProgress: (name: string, result: LandResult) => void
}): Promise<{ landed: string[]; failedAt?: string; error?: string }> {
  const landed: string[] = []
  while (true) {
    const status = await opts.getStatus()
    const name = status.ready[0]
    if (name === undefined) return { landed }
    try {
      const result = await opts.land(name)
      landed.push(name)
      opts.onProgress(name, result)
    } catch (err) {
      return {
        landed,
        failedAt: name,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

export function parseConvergeStatus(value: unknown): ConvergeStatus {
  const record = asRecord(value)
  return {
    ready: stringList(record.ready),
    unknown: namedReasons(record.unknown),
    blocked: namedReasons(record.blocked),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function namedReasons(value: unknown): { name: string; reason: string }[] {
  if (!Array.isArray(value)) return []
  const out: { name: string; reason: string }[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (typeof record.name === 'string' && record.name.length > 0) {
      out.push({
        name: record.name,
        reason: typeof record.reason === 'string' ? record.reason : '',
      })
    }
  }
  return out
}
