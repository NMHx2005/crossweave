/**
 * What each enforcement tier actually intercepts, in one place.
 *
 * A bare `T2` in a session list reads as "protected" — and it is not: T2 blocks
 * `Edit`/`Write` and nothing else, its `Bash` coverage is advisory, and T3 intercepts
 * nothing at all. The table in
 * docs/superpowers/specs/2026-09-17-tier-coverage-honesty-design.md §2 is the source
 * of truth; this module is that table in code so every surface prints the same words
 * instead of drifting into its own phrasing.
 *
 * `short` is for the places a tier sits next to other metadata (a rail row, a session
 * list column); `long` is for a line that has room to say what it means.
 */
export interface TierCoverage {
  short: string;
  long: string;
}

export const ENFORCEMENT_COVERAGE: Record<string, TierCoverage> = {
  T1: {
    short: 'named writes',
    long: 'blocks file writes the agent names, when the ACP client reports them',
  },
  T2: {
    short: 'Edit|Write',
    long: 'blocks Edit|Write; Bash is watched after the fact, advisory only',
  },
  T3: {
    short: 'nothing',
    long: 'intercepts nothing — a cooperative agent, not a sandbox',
  },
};

/**
 * `T2 · Edit|Write` — the tier and its coverage, for anywhere a human reads it.
 *
 * Accepts a plain string (the shape the CLI and the cockpit actually receive off the
 * RPC) rather than `EnforcementTier`: an unknown tier is printed as-is instead of
 * being labelled with coverage nobody verified.
 */
export function tierWithCoverage(tier: string): string {
  const coverage = ENFORCEMENT_COVERAGE[tier];
  return coverage === undefined ? tier : `${tier} · ${coverage.short}`;
}

/** The same thing in a sentence, for the one line that can afford to explain itself. */
export function tierCoverageSentence(tier: string): string | undefined {
  const coverage = ENFORCEMENT_COVERAGE[tier];
  return coverage === undefined ? undefined : `${tier} · ${coverage.long}`;
}
