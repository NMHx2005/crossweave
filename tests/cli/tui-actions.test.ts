import { describe, expect, test } from 'bun:test';
import { landAllInOrder } from '../../src/cli/commands/tui.js';

describe('landAllInOrder', () => {
  test('lands each name in order, stopping at the first failure', async () => {
    const attempted: string[] = [];
    const land = async (name: string) => {
      attempted.push(name);
      if (name === 'bob') throw new Error('conflict');
    };
    const results = await landAllInOrder(['alice', 'bob', 'carol'], land);
    expect(attempted).toEqual(['alice', 'bob']); // carol never attempted
    expect(results.landed).toEqual(['alice']);
    expect(results.failedAt).toBe('bob');
  });

  test('all succeed when nothing fails', async () => {
    const attempted: string[] = [];
    const land = async (name: string) => { attempted.push(name); };
    const results = await landAllInOrder(['alice', 'bob'], land);
    expect(attempted).toEqual(['alice', 'bob']);
    expect(results.landed).toEqual(['alice', 'bob']);
    expect(results.failedAt).toBeUndefined();
  });
});
