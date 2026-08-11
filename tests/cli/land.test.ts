import { describe, expect, test } from 'bun:test';
import { assertLandConfirmed } from '../../src/cli/commands/land.js';

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
