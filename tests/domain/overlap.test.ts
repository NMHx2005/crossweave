import { describe, expect, test } from 'bun:test';
import { overlapPairs } from '../../src/domain/overlap.js';

describe('overlapPairs', () => {
  test('two sessions sharing one path name each other with just that path', () => {
    const result = overlapPairs([
      { name: 'alice', paths: ['x', 'y'] },
      { name: 'bob', paths: ['y', 'z'] },
    ]);
    expect(result.get('alice')).toEqual([{ session: 'bob', paths: ['y'] }]);
    expect(result.get('bob')).toEqual([{ session: 'alice', paths: ['y'] }]);
  });

  test('disjoint sets produce an empty map', () => {
    const result = overlapPairs([
      { name: 'alice', paths: ['x'] },
      { name: 'bob', paths: ['y'] },
    ]);
    expect(result.size).toBe(0);
  });

  test('a path shared by three is returned by all three', () => {
    const result = overlapPairs([
      { name: 'a', paths: ['shared'] },
      { name: 'b', paths: ['shared'] },
      { name: 'c', paths: ['shared'] },
    ]);
    expect(result.get('a')).toEqual([
      { session: 'b', paths: ['shared'] },
      { session: 'c', paths: ['shared'] },
    ]);
    expect(result.get('b')).toHaveLength(2);
    expect(result.get('c')).toHaveLength(2);
  });

  test('a session with no paths overlaps nothing', () => {
    expect(overlapPairs([{ name: 'a', paths: [] }, { name: 'b', paths: [] }]).size).toBe(0);
    expect(overlapPairs([{ name: 'a', paths: ['x'] }, { name: 'b', paths: [] }]).size).toBe(0);
  });

  test('duplicate paths are deduped, and blank paths are ignored', () => {
    const result = overlapPairs([
      { name: 'a', paths: ['p', 'p', ''] },
      { name: 'b', paths: ['p'] },
    ]);
    expect(result.get('a')).toEqual([{ session: 'b', paths: ['p'] }]);
  });

  test('the order is deterministic: by other session name, then by path', () => {
    const result = overlapPairs([
      { name: 'me', paths: ['z', 'a', 'm'] },
      { name: 'zoe', paths: ['z', 'm'] },
      { name: 'ann', paths: ['a'] },
    ]);
    expect(result.get('me')).toEqual([
      { session: 'ann', paths: ['a'] },
      { session: 'zoe', paths: ['m', 'z'] },
    ]);
  });
});
