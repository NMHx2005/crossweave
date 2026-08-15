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
  test('aggregates session count and total burn', () => {
    const sessions = [
      { costSpentUsd: 1.0 }, { costSpentUsd: 0.24 },
    ] as any;
    // `WorkspaceInfo` (src/domain/workspace.ts) carries only `{ workspace, sessions }` —
    // there is no disk-usage field anywhere on `WorkspaceRow` or `WorkspaceInfo`, so
    // (unlike the brief's illustrative `diskInfo` sketch) this function takes no
    // third argument; the status bar reports what the fetched data actually has.
    const out = formatStatusBar({ id: 'ws_1', name: 'w' } as any, sessions);
    expect(out).toContain('w');
    expect(out).toContain('2 session');
    expect(out).toContain('1.24');
  });
  test('singular session count is not pluralized', () => {
    const out = formatStatusBar({ id: 'ws_1', name: 'solo' } as any, [{ costSpentUsd: 0 }] as any);
    expect(out).toContain('1 session');
    expect(out).not.toContain('1 sessions');
  });
});
