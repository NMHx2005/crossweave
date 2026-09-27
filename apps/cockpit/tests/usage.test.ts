import { describe, expect, test } from 'bun:test'
import { formatCost, formatTokens, sumUsage, usageCost, usageLabel } from '../src/lib/usage'

const u = (input: number, output: number, cacheWrite = 0, cacheRead = 0) => ({ input, output, cacheWrite, cacheRead })
const session = (byModel: Record<string, ReturnType<typeof u>>) => sumUsage([{ total: u(0, 0), byModel }])

describe('formatting', () => {
  test('tokens and dollars at rail width', () => {
    expect([formatTokens(950), formatTokens(1234), formatTokens(12_345), formatTokens(1_234_567), formatTokens(12_345_678)]).toEqual(['950', '1.2k', '12k', '1.2M', '12M'])
    expect([formatCost(0), formatCost(0.004), formatCost(4.1), formatCost(123.4)]).toEqual(['$0.00', '<$0.01', '$4.10', '$123'])
  })
})

describe('usageCost', () => {
  const prices = { opus: { input: 10, output: 50, cacheWrite: 12, cacheRead: 1 } }
  test('priced models only; a floor when some are not priced', () => {
    expect(usageCost(session({ opus: u(1_000_000, 100_000, 0, 2_000_000) }), prices)).toEqual({ usd: 10 + 5 + 2, complete: true })
    expect(usageCost(session({ opus: u(1_000_000, 0), other: u(5, 5) }), prices)).toEqual({ usd: 10, complete: false })
    expect(usageCost(session({ other: u(5, 5) }), prices)).toBeUndefined()
    expect(usageCost(session({ opus: u(5, 5) }), undefined)).toBeUndefined()
  })
})

describe('usageLabel', () => {
  test('cost when priced (with + when partial), tokens otherwise, nothing when unused', () => {
    const prices = { opus: { input: 10, output: 50, cacheWrite: 12, cacheRead: 1 } }
    expect(usageLabel(session({ opus: u(1_000_000, 0) }), prices)?.text).toBe('$10.00')
    expect(usageLabel(session({ opus: u(1_000_000, 0), other: u(1, 1) }), prices)?.text).toBe('$10.00+')
    expect(usageLabel(session({ other: u(1500, 0) }), prices)?.text).toBe('1.5k')
    expect(usageLabel(session({}), prices)).toBeUndefined()
    expect(usageLabel(undefined, prices)).toBeUndefined()
    expect(usageLabel(session({ other: u(1500, 0) }), prices)?.title).toContain('Settings → Usage')
  })
})

describe('sumUsage', () => {
  test('a project total over its sessions, by model', () => {
    const total = sumUsage([session({ opus: u(1, 2) }), undefined, session({ opus: u(3, 4), codex: u(5, 6) })])
    expect(total.byModel).toEqual({ opus: u(4, 6), codex: u(5, 6) })
    expect(total.total).toEqual(u(9, 12))
  })
})

