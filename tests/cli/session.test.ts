import { describe, expect, test } from 'bun:test';
import {
  formatLeaseSummary,
} from '../../src/cli/commands/session.js';

describe('formatLeaseSummary', () => {
  test('missing leases render as a dash', () => {
    expect(formatLeaseSummary(undefined)).toBe('-');
  });

  test('renders every allocated resource in a compact stable order', () => {
    expect(formatLeaseSummary({
      portBase: 43000,
      composeProject: 'cw_s_1',
      cachePath: '.crossweave/cache/s_1',
      dbStrategy: 'schema',
      dbValue: 'cw_s_1',
    })).toBe(
      'port=43000,compose=cw_s_1,cache=.crossweave/cache/s_1,db=schema:cw_s_1',
    );
  });

  test('omits optional resources that were not leased', () => {
    expect(formatLeaseSummary({
      portBase: 43000,
      composeProject: 'cw_s_1',
      cachePath: null,
      dbStrategy: 'none',
      dbValue: null,
    })).toBe('port=43000,compose=cw_s_1');
  });
});
