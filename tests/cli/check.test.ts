import { describe, expect, it } from 'bun:test';
import { formatVerdict } from '../../src/cli/commands/check.js';

describe('formatVerdict', () => {
  it('one line for a pass, with how long it took', () => {
    expect(formatVerdict('alpha', { state: 'pass', ms: 4200 })).toBe('alpha: checks pass (4.2s)');
  });

  it('a failure names the exit code and ends with the output tail, trimmed', () => {
    expect(formatVerdict('alpha', { state: 'fail', code: 1, ms: 1000, tail: '3 fail\n\n' })).toBe('alpha: checks FAIL (exit 1) (1.0s)\n3 fail');
  });

  it('running and unknown durations do not invent numbers', () => {
    expect(formatVerdict('alpha', { state: 'running' })).toBe('alpha: checks running');
    expect(formatVerdict('alpha', { state: 'fail' })).toBe('alpha: checks FAIL');
  });
});
