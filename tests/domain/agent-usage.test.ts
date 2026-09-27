import { afterAll, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectDir } from '../../src/domain/agent-logs.js';
import { addUsage, claudeUsageFrom, codexUsageFrom, UsageReader, UsageTracker, type TokenUsage } from '../../src/domain/agent-usage.js';

// The line shapes as the agents write them (checked against real logs on 2026-09-27).
const claudeLine = (id: string, ts: string, model: string, u: Partial<Record<string, number>>) => JSON.stringify({
  type: 'assistant', timestamp: ts,
  message: {
    id, model, role: 'assistant', content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...u },
  },
});
const codexMeta = (cwd: string, ts: string) => JSON.stringify({ type: 'session_meta', timestamp: ts, payload: { id: 'r1', cwd, timestamp: ts } });
const codexModel = (model: string, ts: string) => JSON.stringify({ type: 'turn_context', timestamp: ts, payload: { model } });
const codexCount = (ts: string, input: number, cached: number, output: number) => JSON.stringify({
  type: 'event_msg', timestamp: ts,
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output } } },
});

const parse = (lines: string[]): unknown[] => lines.map((l) => JSON.parse(l));

describe('claudeUsageFrom', () => {
  // One message is written over several lines (streamed); counting each line counted
  // the same tokens two, three times.
  it('counts each message once, by id, per model', () => {
    const byModel = claudeUsageFrom(parse([
      claudeLine('m1', '2026-09-27T10:00:00Z', 'claude-opus', { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1000 }),
      claudeLine('m1', '2026-09-27T10:00:01Z', 'claude-opus', { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1000 }),
      claudeLine('m2', '2026-09-27T10:01:00Z', 'claude-sonnet', { input_tokens: 7, output_tokens: 20, cache_creation_input_tokens: 300 }),
      JSON.stringify({ type: 'user', timestamp: '2026-09-27T10:02:00Z', message: { content: 'x' } }),
    ]), 0);
    expect(byModel).toEqual({
      'claude-opus': { input: 5, output: 100, cacheWrite: 0, cacheRead: 1000 },
      'claude-sonnet': { input: 7, output: 20, cacheWrite: 300, cacheRead: 0 },
    });
  });

  it('only what was written since the session began', () => {
    const byModel = claudeUsageFrom(parse([
      claudeLine('old', '2026-09-26T10:00:00Z', 'claude-opus', { output_tokens: 999 }),
      claudeLine('new', '2026-09-27T10:00:00Z', 'claude-opus', { output_tokens: 1 }),
    ]), Date.parse('2026-09-27T00:00:00Z'));
    expect(byModel['claude-opus']?.output).toBe(1);
  });
});

describe('codexUsageFrom', () => {
  // Codex writes running totals: the session's share is the last total minus the total
  // before the session began.
  it('the cumulative total since the session began, split into fresh and cached input', () => {
    const lines = parse([
      codexMeta('/w', '2026-09-27T09:00:00Z'),
      codexModel('gpt-5-codex', '2026-09-27T09:00:01Z'),
      codexCount('2026-09-27T09:30:00Z', 1000, 400, 50),
      codexCount('2026-09-27T10:30:00Z', 5000, 3000, 250),
    ]);
    expect(codexUsageFrom(lines, 0)).toEqual({ 'gpt-5-codex': { input: 2000, output: 250, cacheWrite: 0, cacheRead: 3000 } });
    expect(codexUsageFrom(lines, Date.parse('2026-09-27T10:00:00Z'))).toEqual({ 'gpt-5-codex': { input: 1400, output: 200, cacheWrite: 0, cacheRead: 2600 } });
    expect(codexUsageFrom(lines, Date.parse('2026-09-28T00:00:00Z'))).toEqual({});
  });
});

describe('addUsage', () => {
  it('adds field by field', () => {
    const a: TokenUsage = { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 };
    expect(addUsage(a, a)).toEqual({ input: 2, output: 4, cacheWrite: 6, cacheRead: 8 });
  });
});

describe('UsageReader', () => {
  const home = mkdtempSync(join(tmpdir(), 'cw-usage-'));
  afterAll(() => { try { renameSync(home, join(homedir(), '.Trash', `cw-usage-${Date.now()}`)); } catch { /* left in tmp */ } });

  it('reads a worktree\'s Claude and Codex logs, and only the new part of a growing log', () => {
    const cwd = join(home, 'work', 'api');
    mkdirSync(cwd, { recursive: true });
    const claudeDir = claudeProjectDir(home, cwd);
    mkdirSync(claudeDir, { recursive: true });
    const log = join(claudeDir, 'conv.jsonl');
    writeFileSync(log, `${claudeLine('m1', '2026-09-27T10:00:00Z', 'claude-opus', { output_tokens: 10 })}\n`);
    const codexDir = join(home, '.codex', 'sessions', '2026', '09', '27');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'rollout-2026-09-27T10-00-00-r1.jsonl'), [
      codexMeta(cwd, '2026-09-27T10:00:00Z'), codexModel('gpt-5-codex', '2026-09-27T10:00:01Z'), codexCount('2026-09-27T10:05:00Z', 100, 0, 5),
    ].join('\n') + '\n');

    const reader = new UsageReader(home);
    const first = reader.read(cwd, 0);
    expect(first.byModel).toEqual({
      'claude-opus': { input: 0, output: 10, cacheWrite: 0, cacheRead: 0 },
      'gpt-5-codex': { input: 100, output: 5, cacheWrite: 0, cacheRead: 0 },
    });
    expect(first.total).toEqual({ input: 100, output: 15, cacheWrite: 0, cacheRead: 0 });

    // The log grows; the same message id streamed again, and a new message.
    appendFileSync(log, `${claudeLine('m1', '2026-09-27T10:00:01Z', 'claude-opus', { output_tokens: 10 })}\n`);
    appendFileSync(log, `${claudeLine('m2', '2026-09-27T10:02:00Z', 'claude-opus', { output_tokens: 7 })}\n`);
    expect(reader.read(cwd, 0).byModel['claude-opus']?.output).toBe(17);
  });

  it('a worktree with no logs uses nothing', () => {
    expect(new UsageReader(home).read(join(home, 'nowhere'), 0)).toEqual({ total: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, byModel: {} });
  });
});

describe('UsageTracker', () => {
  const some = { total: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 }, byModel: { m: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 } } };
  const none = { total: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, byModel: {} };

  it('serves the last read, throttles, reports changes, forgets empty and gone sessions', async () => {
    let clock = 0;
    let answer: typeof some | typeof none = some;
    let reads = 0;
    const tracker = new UsageTracker({ read: () => { reads += 1; return answer; } }, () => clock, 5000);
    const targets = () => [{ id: 's1', cwd: '/w', since: 0 }];
    expect(await tracker.refresh(targets)).toBe(true);
    expect(tracker.get('s1')).toEqual(some);
    clock = 1000;
    expect(await tracker.refresh(targets)).toBe(false);
    expect(reads).toBe(1);
    clock = 6000;
    expect(await tracker.refresh(targets)).toBe(false);
    clock = 12000;
    answer = none;
    expect(await tracker.refresh(targets)).toBe(true);
    expect(tracker.get('s1')).toBeUndefined();
    answer = some;
    clock = 18000;
    await tracker.refresh(targets);
    clock = 24000;
    expect(await tracker.refresh(() => [])).toBe(true);
    expect(tracker.get('s1')).toBeUndefined();
  });
});
