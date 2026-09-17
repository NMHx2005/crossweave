import { describe, expect, test } from 'bun:test';
import { ENFORCEMENT_COVERAGE, tierCoverageSentence, tierWithCoverage } from '../../src/adapters/coverage.js';

describe('enforcement coverage labels', () => {
  test('each tier prints its coverage next to its name, never the bare tier', () => {
    expect(tierWithCoverage('T1')).toBe('T1 · named writes');
    expect(tierWithCoverage('T2')).toBe('T2 · Edit|Write');
    expect(tierWithCoverage('T3')).toBe('T3 · nothing');
  });

  test('T2 is not allowed to read as blanket protection', () => {
    // The whole point of this module: a session list saying "T2" implies the agent
    // is contained, which is false for Bash and for anything outside the two tools.
    const t2 = ENFORCEMENT_COVERAGE['T2']!;
    expect(t2.short).not.toBe('all writes');
    expect(t2.long).toContain('advisory');
  });

  test('every tier the schema can hold has coverage text', () => {
    for (const tier of ['T1', 'T2', 'T3']) {
      expect(tierWithCoverage(tier)).toMatch(/ · /);
      expect(tierCoverageSentence(tier)).toContain(tier);
    }
  });

  test('an unknown tier is printed as-is rather than given coverage nobody verified', () => {
    expect(tierWithCoverage('T9')).toBe('T9');
    expect(tierCoverageSentence('T9')).toBeUndefined();
    expect(tierWithCoverage('')).toBe('');
  });
});
