import { describe, expect, test } from 'bun:test';
import { classifyLandability, type ClassifyInput } from '../../src/convergence/evidence.js';
import type { MergeTrialRow } from '../../src/db/repositories/merge-trial.js';

const sessions = [
  { name: 'a', branch: 'cw/a' },
  { name: 'b', branch: 'cw/b' },
];

function trial(overrides: Partial<MergeTrialRow> = {}): MergeTrialRow {
  return {
    id: 'mt_1',
    workspaceId: 'ws_1',
    ts: '2026-09-15T00:00:00.000Z',
    branches: ['cw/a', 'cw/b'],
    result: 'clean',
    detail: null,
    baseHead: 'base-current',
    ...overrides,
  };
}

function classify(overrides: Partial<ClassifyInput> = {}) {
  return classifyLandability({
    sessions,
    trials: [trial()],
    currentBaseHead: 'base-current',
    degraded: false,
    hasTrustedTestCommand: false,
    latestFullIntegration: null,
    ...overrides,
  });
}

describe('classifyLandability', () => {
  test('marks every session ready when all required pairwise evidence is fresh and clean', () => {
    const result = classify({});

    expect(result.ready).toEqual(['a', 'b']);
    expect(result.byName.get('a')?.landability).toBe('ready');
    expect(result.byName.get('b')?.landability).toBe('ready');
  });

  test('marks sessions unknown when their latest pairwise evidence is from another base head', () => {
    const result = classify({ trials: [trial({ baseHead: 'base-old' })] });

    expect(result.ready).toEqual([]);
    expect(result.byName.get('a')?.landability).toBe('unknown');
    expect(result.byName.get('b')?.landability).toBe('unknown');
  });

  test('marks sessions unknown in degraded mode even when pairwise evidence is clean', () => {
    const result = classify({ degraded: true });

    expect(result.ready).toEqual([]);
    expect(result.byName.get('a')?.landability).toBe('unknown');
    expect(result.byName.get('b')?.landability).toBe('unknown');
  });

  test('marks both participants blocked when their latest pairwise trial conflicts', () => {
    const result = classify({ trials: [trial({ result: 'conflict' })] });

    expect(result.ready).toEqual([]);
    expect(result.byName.get('a')?.landability).toBe('blocked');
    expect(result.byName.get('b')?.landability).toBe('blocked');
  });

  test('does not require full-integration evidence without a trusted test command', () => {
    const result = classify({ latestFullIntegration: trial({ branches: sessions.map((s) => s.branch), result: 'unverified' }) });

    expect(result.ready).toEqual(['a', 'b']);
  });

  test('requires a clean full-integration trial when a trusted test command is configured', () => {
    const missing = classify({ hasTrustedTestCommand: true });
    const unverified = classify({
      hasTrustedTestCommand: true,
      latestFullIntegration: trial({ result: 'unverified' }),
    });

    expect(missing.ready).toEqual([]);
    expect(missing.byName.get('a')?.landability).toBe('unknown');
    expect(unverified.ready).toEqual([]);
    expect(unverified.byName.get('b')?.landability).toBe('unknown');
  });

  test('requires full-integration evidence from the current base head', () => {
    const result = classify({
      hasTrustedTestCommand: true,
      latestFullIntegration: trial({ result: 'clean', baseHead: 'base-old' }),
    });

    expect(result.ready).toEqual([]);
    expect(result.byName.get('a')?.landability).toBe('unknown');
  });

  test('uses the latest trial for a sorted pair regardless of branch order', () => {
    const result = classify({
      trials: [
        trial({ id: 'old', result: 'conflict' }),
        trial({
          id: 'new',
          ts: '2026-09-15T00:00:01.000Z',
          branches: ['cw/b', 'cw/a'],
          result: 'clean',
        }),
      ],
    });

    expect(result.ready).toEqual(['a', 'b']);
  });
});
