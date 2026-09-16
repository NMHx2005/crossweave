import {
  landAllLoop,
  type ConvergeStatus,
  type LandResult,
} from '../../../../src/convergence/land-order.js'

export type { ConvergeStatus, LandResult }

export type LandSelectedResult =
  | { status: 'landed' }
  | { status: 'blocked' }
  | { status: 'needs_confirm_unknown' }
  | { status: 'failed'; error: string }

/**
 * Evidence-gated land of one named session. Blocked never lands.
 * Unknown lands only after forceUnknown (UI confirm). Never maps that to RPC force.
 */
export async function landSelected(opts: {
  getStatus: () => Promise<ConvergeStatus>
  land: (name: string) => Promise<LandResult>
  name: string
  forceUnknown?: boolean
}): Promise<LandSelectedResult> {
  let status: ConvergeStatus
  try {
    status = await opts.getStatus()
  } catch (err) {
    return { status: 'failed', error: errorMessage(err) }
  }

  if (status.blocked.some((entry) => entry.name === opts.name)) return { status: 'blocked' }
  const unknown = status.unknown.some((entry) => entry.name === opts.name)
  if (unknown && !opts.forceUnknown) return { status: 'needs_confirm_unknown' }
  const ready = status.ready.includes(opts.name)
  if (!ready && !unknown) return { status: 'failed', error: 'session is not evidence-ready' }

  try {
    await opts.land(opts.name)
    return { status: 'landed' }
  } catch (err) {
    return { status: 'failed', error: errorMessage(err) }
  }
}

/**
 * Same re-fetch loop as `cw land all` without evidence-force: only `ready`.
 */
export async function landAllReady(opts: {
  getStatus: () => Promise<ConvergeStatus>
  land: (name: string) => Promise<LandResult>
  onProgress: (name: string, result: LandResult) => void
}): Promise<{ landed: string[]; failedAt?: string; error?: string }> {
  return landAllLoop({ ...opts, force: false })
}

export function parseConvergeStatus(value: unknown): ConvergeStatus {
  const record = asRecord(value)
  return {
    ready: stringList(record.ready),
    unknown: namedReasons(record.unknown),
    blocked: namedReasons(record.blocked),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
