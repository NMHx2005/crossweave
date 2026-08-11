import { describe, expect, test } from 'bun:test';
import { parseContractTarget } from '../../src/cli/commands/contract.js';

describe('parseContractTarget', () => {
  test('splits "<file>#<Name>" on the LAST hash, so a path containing "#" still parses', () => {
    expect(parseContractTarget('src/auth.ts#AuthService')).toEqual({
      symbolFqn: 'src/auth.ts#AuthService', path: 'src/auth.ts', name: 'AuthService',
    });
  });

  test('rejects a target with no "#"', () => {
    expect(() => parseContractTarget('src/auth.ts')).toThrow(/Expected/);
  });
});
