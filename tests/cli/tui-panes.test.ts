import { describe, expect, test } from 'bun:test';
import { formatConvergenceMatrix, formatFeedLine, formatSessionRow, formatStatusBar } from '../../src/cli/commands/tui.js';
import { format, type NotifyEvent } from '../../src/notify/dispatcher.js';

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

describe('formatConvergenceMatrix', () => {
  // `converge.status`'s `pairwise` entries carry branch names, not session
  // names (see src/daemon/methods.ts's 'converge.status' handler — it never
  // resolves them). `alice`/`bob` double as both branch and session name in
  // these first two cases purely for brevity; the dedicated resolution test
  // below is the one that actually proves branch->name lookup works.
  const identityMap = new Map([['alice', 'alice'], ['bob', 'bob']]);

  test('builds a symmetric grid from pairwise results', () => {
    const grid = formatConvergenceMatrix(
      ['alice', 'bob'],
      [{ a: 'alice', b: 'bob', result: 'clean' }],
      identityMap,
    );
    expect(grid[0]![1]).toBe('clean');
    expect(grid[1]![0]).toBe('clean'); // symmetric
    expect(grid[0]![0]).toBe('—'); // diagonal
  });

  test('a pair with no trial yet shows unknown', () => {
    const grid = formatConvergenceMatrix(['alice', 'bob'], [], new Map());
    expect(grid[0]![1]).toBe('?');
  });

  test('resolves branch names to session names via the lookup, not the raw pairwise a/b', () => {
    const branchToSessionName = new Map([
      ['feature/alice-x', 'alice'],
      ['feature/bob-y', 'bob'],
    ]);
    const grid = formatConvergenceMatrix(
      ['alice', 'bob'],
      [{ a: 'feature/alice-x', b: 'feature/bob-y', result: 'conflict' }],
      branchToSessionName,
    );
    expect(grid[0]![1]).toBe('conflict');
    expect(grid[1]![0]).toBe('conflict');
  });

  test('a non-clean, non-conflict trial result (e.g. test_fail) still reads as not-clean', () => {
    const grid = formatConvergenceMatrix(
      ['alice', 'bob'],
      [{ a: 'alice', b: 'bob', result: 'test_fail' }],
      identityMap,
    );
    expect(grid[0]![1]).toBe('conflict');
  });

  test('a branch missing from the lookup does not crash and leaves the pair unknown', () => {
    const grid = formatConvergenceMatrix(
      ['alice', 'bob'],
      [{ a: 'unknown-branch', b: 'bob', result: 'clean' }],
      new Map([['bob', 'bob']]),
    );
    expect(grid[0]![1]).toBe('?');
  });
});

describe('radar feed line formatting', () => {
  test('a collision tui.event produces the same text format() would give the desktop notification', () => {
    const event: NotifyEvent = {
      kind: 'collision', sessionA: 'alice', sessionB: 'bob', path: 'src/x.ts', symbol: 'foo', workspaceId: 'ws_1',
    };
    const formatted = format(event);
    const line = formatFeedLine(event);
    // Reuses format()'s own fields verbatim, not a parallel reimplementation of the
    // event -> text logic — this is the whole point (design doc §3.2): the feed
    // pane and the desktop notification must never drift apart.
    expect(line).toContain(formatted.title);
    expect(line).toContain(formatted.message);
  });

  test('a blocked tui.event also reuses format() verbatim', () => {
    const event: NotifyEvent = { kind: 'blocked', session: 'alice', path: 'src/y.ts', symbol: null, workspaceId: 'ws_1' };
    const formatted = format(event);
    const line = formatFeedLine(event);
    expect(line).toContain(formatted.title);
    expect(line).toContain(formatted.message);
  });

  test('prefixes a timestamp ahead of the formatted text', () => {
    const event: NotifyEvent = { kind: 'land', session: 'alice', ok: true, baseBranch: 'main', workspaceId: 'ws_1' };
    const formatted = format(event);
    const line = formatFeedLine(event);
    expect(line.indexOf(formatted.title)).toBeGreaterThan(0);
  });
});
