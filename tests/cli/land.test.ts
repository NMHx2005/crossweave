import { describe, expect, test } from 'bun:test';
import { assertLandConfirmed, chooseNextLand } from '../../src/cli/commands/land.js';

describe('assertLandConfirmed', () => {
  test('throws CONFIRMATION_REQUIRED when --yes is not passed', () => {
    expect(() => assertLandConfirmed(false)).toThrowError(
      expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }) as unknown as Error,
    );
  });

  test('does not throw when --yes is passed', () => {
    expect(() => assertLandConfirmed(true)).not.toThrow();
  });
});

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
