import { describe, expect, test } from 'bun:test';
import { formatSessionRow, formatStatusBar } from '../../src/cli/commands/tui.js';

describe('formatSessionRow', () => {
  test('running session shows a filled dot and its tier', () => {
    const row = { name: 'alice', status: 'running', enforcementTier: 'T2', costSpentUsd: 0 } as any;
    const out = formatSessionRow(row);
    expect(out.dot).toBe('●');
    expect(out.text).toContain('alice');
    expect(out.text).toContain('T2');
  });
  test('waiting session also shows a filled dot (still live, per domain/bus.ts grouping)', () => {
    const row = { name: 'dave', status: 'waiting', enforcementTier: 'T2', costSpentUsd: 0 } as any;
    expect(formatSessionRow(row).dot).toBe('●');
  });
  test('idle session shows a hollow dot', () => {
    const row = { name: 'bob', status: 'idle', enforcementTier: 'T1', costSpentUsd: 0 } as any;
    expect(formatSessionRow(row).dot).toBe('○');
  });
  test('dead session shows an x', () => {
    const row = { name: 'carol', status: 'dead', enforcementTier: 'T3', costSpentUsd: 0 } as any;
    expect(formatSessionRow(row).dot).toBe('✕');
  });
  test('landed session also shows an x (terminal, grouped with dead per domain/gc.ts)', () => {
    const row = { name: 'erin', status: 'landed', enforcementTier: 'T3', costSpentUsd: 0 } as any;
    expect(formatSessionRow(row).dot).toBe('✕');
  });
});

describe('formatStatusBar', () => {
  test('aggregates session count, total burn, and disk usage', () => {
    const sessions = [
      { costSpentUsd: 1.0 }, { costSpentUsd: 0.24 },
    ] as any;
    // `disk` is real data as of this fix round: `workspace.info`'s RPC handler
    // (src/daemon/methods.ts) enriches `WorkspaceManager.info()`'s `{workspace,
    // sessions}` with usage measured by `measureWorktrees` (M1's Disk Guard,
    // src/isolation/disk-guard.ts) — not a placeholder shape.
    const out = formatStatusBar(
      { id: 'ws_1', name: 'w' } as any,
      sessions,
      { usedBytes: 4_200_000_000, limitBytes: 20_000_000_000 },
    );
    expect(out).toContain('w');
    expect(out).toContain('2 session');
    expect(out).toContain('1.24');
    expect(out).toContain('3.9GB');
    expect(out).toContain('18.6GB');
  });
  test('singular session count is not pluralized', () => {
    const out = formatStatusBar(
      { id: 'ws_1', name: 'solo' } as any,
      [{ costSpentUsd: 0 }] as any,
      { usedBytes: 0, limitBytes: 1 },
    );
    expect(out).toContain('1 session');
    expect(out).not.toContain('1 sessions');
  });
});
