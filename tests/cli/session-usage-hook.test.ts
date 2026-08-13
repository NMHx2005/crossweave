import { describe, expect, test } from 'bun:test';
import { runSessionUsageHook, type ReportUsageFn } from '../../src/cli/commands/session-usage-hook.js';

function stdinFor(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cwd: '/tmp/w',
    cost: { total_cost_usd: 0.01234 },
    context_window: { total_input_tokens: 15500, total_output_tokens: 1200 },
    ...overrides,
  });
}

describe('runSessionUsageHook', () => {
  test('valid payload reports cost + combined tokens and prints a status line', async () => {
    let reported: [string, string, number | undefined, number | undefined] | undefined;
    const report: ReportUsageFn = async (cwd, sessionId, tokensUsed, costUsd) => {
      reported = [cwd, sessionId, tokensUsed, costUsd];
    };
    const out = await runSessionUsageHook(stdinFor(), 's_1', report);
    expect(reported).toEqual(['/tmp/w', 's_1', 16700, 0.01234]);
    expect(out).toBe('$0.0123 · 16.7k tokens');
  });

  test('missing CW_SESSION_ID (sessionId undefined): no report call, empty output, no throw', async () => {
    let called = false;
    const report: ReportUsageFn = async () => { called = true; };
    const out = await runSessionUsageHook(stdinFor(), undefined, report);
    expect(called).toBe(false);
    expect(out).toBe('');
  });

  test('malformed JSON: no report call, empty output, no throw', async () => {
    let called = false;
    const report: ReportUsageFn = async () => { called = true; };
    const out = await runSessionUsageHook('not json at all', 's_1', report);
    expect(called).toBe(false);
    expect(out).toBe('');
  });

  test('valid JSON that is not an object (e.g. `null`): empty output, no throw', async () => {
    const out = await runSessionUsageHook('null', 's_1', async () => {});
    expect(out).toBe('');
  });

  test('missing cwd field: no report call, empty output', async () => {
    let called = false;
    const report: ReportUsageFn = async () => { called = true; };
    const out = await runSessionUsageHook(stdinFor({ cwd: undefined }), 's_1', report);
    expect(called).toBe(false);
    expect(out).toBe('');
  });

  test('an unreachable daemon (report throws): degrades to empty output, never crashes', async () => {
    const report: ReportUsageFn = async () => { throw new Error('daemon unreachable'); };
    const out = await runSessionUsageHook(stdinFor(), 's_1', report);
    expect(out).toBe('');
  });

  test('cost only (no context_window): reports cost, formats a cost-only status line', async () => {
    let reported: [string, string, number | undefined, number | undefined] | undefined;
    const report: ReportUsageFn = async (cwd, sessionId, tokensUsed, costUsd) => {
      reported = [cwd, sessionId, tokensUsed, costUsd];
    };
    const out = await runSessionUsageHook(stdinFor({ context_window: undefined }), 's_1', report);
    expect(reported).toEqual(['/tmp/w', 's_1', undefined, 0.01234]);
    expect(out).toBe('$0.0123');
  });

  test('neither cost nor context_window present: no report call, empty output', async () => {
    let called = false;
    const report: ReportUsageFn = async () => { called = true; };
    const out = await runSessionUsageHook(stdinFor({ cost: undefined, context_window: undefined }), 's_1', report);
    expect(called).toBe(false);
    expect(out).toBe('');
  });
});
