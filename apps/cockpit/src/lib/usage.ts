import type { ModelPrice } from '../../../../src/core/settings.js'

export type TokenUsage = { input: number; output: number; cacheWrite: number; cacheRead: number }
export type SessionUsage = {
  total: TokenUsage
  byModel: Record<string, TokenUsage>
  /** The project folder's logs, shared by every session working there. */
  folder?: boolean
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }

export function tokenCount(u: TokenUsage): number {
  return u.input + u.output + u.cacheWrite + u.cacheRead
}

/** 950 · 12.3k · 4.5M — the rail's width, not an accountant's. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}

/**
 * The cost of what was used, over the models the user priced. `complete` is false when
 * some tokens came from a model with no price — the figure is then a floor.
 */
export function usageCost(usage: SessionUsage, prices: Record<string, ModelPrice> | undefined): { usd: number; complete: boolean } | undefined {
  let usd = 0
  let priced = false
  let complete = true
  for (const [model, u] of Object.entries(usage.byModel)) {
    if (tokenCount(u) === 0) continue
    const p = prices?.[model]
    if (!p) {
      complete = false
      continue
    }
    priced = true
    usd += (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1_000_000
  }
  return priced ? { usd, complete } : undefined
}

/**
 * A project's total: each worktree session's own, plus the project folder's once —
 * every session in the folder reports the same folder figures.
 */
export function projectUsage(list: ReadonlyArray<SessionUsage | undefined>): SessionUsage {
  const own = list.filter((u) => u !== undefined && !u.folder)
  const folder = list.find((u) => u?.folder === true)
  return sumUsage(folder ? [...own, folder] : own)
}

/** Several sessions' usage as one. */
export function sumUsage(list: ReadonlyArray<SessionUsage | undefined>): SessionUsage {
  const byModel: Record<string, TokenUsage> = {}
  for (const u of list) {
    if (!u) continue
    for (const [model, t] of Object.entries(u.byModel)) {
      const b = byModel[model] ?? ZERO
      byModel[model] = { input: b.input + t.input, output: b.output + t.output, cacheWrite: b.cacheWrite + t.cacheWrite, cacheRead: b.cacheRead + t.cacheRead }
    }
  }
  const total = Object.values(byModel).reduce((a, t) => ({ input: a.input + t.input, output: a.output + t.output, cacheWrite: a.cacheWrite + t.cacheWrite, cacheRead: a.cacheRead + t.cacheRead }), ZERO)
  return { total, byModel }
}

/**
 * What the rail shows: the cost when any model is priced (a "+" when some is not), else
 * the token count; the tooltip spells out every model.
 */
export function usageLabel(usage: SessionUsage | undefined, prices: Record<string, ModelPrice> | undefined): { text: string; title: string } | undefined {
  if (!usage || tokenCount(usage.total) === 0) return undefined
  const cost = usageCost(usage, prices)
  const lines = Object.entries(usage.byModel).map(([model, u]) =>
    `${model}: ${formatTokens(u.input)} in · ${formatTokens(u.output)} out · ${formatTokens(u.cacheRead)} cache read · ${formatTokens(u.cacheWrite)} cache write`)
  if (cost) {
    lines.unshift(cost.complete ? `Estimated ${formatCost(cost.usd)}` : `At least ${formatCost(cost.usd)} (some models have no price in Settings)`)
    return { text: `${formatCost(cost.usd)}${cost.complete ? '' : '+'}`, title: lines.join('\n') }
  }
  lines.unshift(`${formatTokens(tokenCount(usage.total))} tokens — set prices in Settings → Usage to see cost`)
  return { text: formatTokens(tokenCount(usage.total)), title: lines.join('\n') }
}
