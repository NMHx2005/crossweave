import { describe, expect, test } from 'bun:test';
import { formatSpend, parseOptionalNumberArg } from '../../src/cli/commands/session.js';

describe('parseOptionalNumberArg', () => {
  test('undefined input returns undefined', () => {
    expect(parseOptionalNumberArg('--budget-usd', undefined)).toBeUndefined();
  });

  test('a valid numeric string parses to a number', () => {
    expect(parseOptionalNumberArg('--budget-usd', '5.5')).toBe(5.5);
  });

  test('a non-numeric string throws INVALID_ARGUMENTS naming the flag', () => {
    expect(() => parseOptionalNumberArg('--budget-usd', 'nope')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENTS' }) as unknown as Error,
    );
  });
});

describe('formatSpend', () => {
  const base = { tokenSpent: 0, tokenBudget: null, costSpentUsd: 0, costBudgetUsd: null };

  test('a fresh session with no budgets shows zero spend, no marker', () => {
    expect(formatSpend(base)).toBe('$0.0000/0.0k');
  });

  test('spend under budget shows no marker', () => {
    expect(formatSpend({ ...base, costSpentUsd: 1, costBudgetUsd: 5 })).toBe('$1.0000/0.0k');
  });

  test('cost spend over its budget appends the OVER BUDGET marker', () => {
    expect(formatSpend({ ...base, costSpentUsd: 6, costBudgetUsd: 5 })).toBe('$6.0000/0.0k OVER BUDGET');
  });

  test('token spend over its budget appends the OVER BUDGET marker', () => {
    expect(formatSpend({ ...base, tokenSpent: 2000, tokenBudget: 1000 })).toBe('$0.0000/2.0k OVER BUDGET');
  });

  test('spend exactly at budget is not over', () => {
    expect(formatSpend({ ...base, costSpentUsd: 5, costBudgetUsd: 5 })).toBe('$5.0000/0.0k');
  });
});
