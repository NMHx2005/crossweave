import { describe, expect, test } from 'bun:test';
import { chooseNextLand, landAllLoop } from '../../src/convergence/land-order.js';

describe('chooseNextLand', () => {
  const status = {
    ready: ['ready-session'],
    unknown: [{ name: 'unknown-session', reason: 'no pairwise trial with peer' }],
    blocked: [{ name: 'blocked-session', reason: 'latest trial with peer is conflict' }],
  };

  test('chooses ready evidence before unknown evidence even with force', () => {
    expect(chooseNextLand(status, true)).toEqual({ name: 'ready-session' });
  });

  test('does not choose incomplete or blocked evidence without force', () => {
    expect(chooseNextLand({ ...status, ready: [] }, false)).toBeUndefined();
  });

  test('chooses unknown evidence with its warning reason only when forced', () => {
    expect(chooseNextLand({ ...status, ready: [] }, true)).toEqual({
      name: 'unknown-session',
      warning: 'no pairwise trial with peer',
    });
  });

  test('never chooses blocked evidence, including when forced', () => {
    expect(chooseNextLand({ ...status, ready: [], unknown: [] }, true)).toBeUndefined();
  });
});

describe('landAllLoop', () => {
  const ok = {
    status: 'landed' as const,
    tested: 'clean' as const,
    baseBranch: 'main',
    warnings: [] as string[],
  };

  test('re-fetches status after every successful land and stops at failure', async () => {
    const snapshots = [
      { ready: ['alice', 'bob'], unknown: [], blocked: [] },
      { ready: ['bob'], unknown: [], blocked: [] },
    ];
    const attempted: string[] = [];
    const result = await landAllLoop({
      getStatus: async () => snapshots.shift() ?? { ready: [], unknown: [], blocked: [] },
      land: async (name) => {
        attempted.push(name);
        if (name === 'bob') throw new Error('conflict');
        return ok;
      },
    });
    expect(attempted).toEqual(['alice', 'bob']);
    expect(result.landed).toEqual(['alice']);
    expect(result.failedAt).toBe('bob');
    expect(result.error).toBe('conflict');
  });

  test('without force does not land unknown sessions', async () => {
    const attempted: string[] = [];
    const result = await landAllLoop({
      getStatus: async () => ({
        ready: [],
        unknown: [{ name: 'maybe', reason: 'unverified' }],
        blocked: [],
      }),
      land: async (name) => {
        attempted.push(name);
        return ok;
      },
    });
    expect(attempted).toEqual([]);
    expect(result.landed).toEqual([]);
  });
});
