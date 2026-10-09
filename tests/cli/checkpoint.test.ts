import { describe, expect, it } from 'bun:test';
import { formatCheckpoint, formatPlan } from '../../src/cli/commands/checkpoint.js';

describe('formatCheckpoint', () => {
  it('one line: number, kind, label, and +added ~modified -deleted', () => {
    expect(formatCheckpoint({ seq: 3, kind: 'turn', at: 0, head: 'abc', tree: 't', files: { added: 1, modified: 2, deleted: 0 } }))
      .toBe('#3  turn  +1 ~2 -0');
    expect(formatCheckpoint({ seq: 4, kind: 'manual', label: 'before refactor', at: 0, head: 'abc', tree: 't', files: { added: 0, modified: 0, deleted: 1 } }))
      .toBe('#4  manual  before refactor  +0 ~0 -1');
  });
});

describe('formatPlan', () => {
  it('lists what would be written and deleted, and says so when there is nothing', () => {
    expect(formatPlan({ write: ['a.txt'], delete: ['b.txt'] })).toBe('write a.txt\ndelete b.txt');
    expect(formatPlan({ write: [], delete: [] })).toBe('nothing to change');
  });
});
