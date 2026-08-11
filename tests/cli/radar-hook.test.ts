import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRadarHook, type RadarCheckFn } from '../../src/cli/commands/radar-hook.js';

const NO_COLLISION: RadarCheckFn = async () => ({ collisions: [] });
const ONE_COLLISION: RadarCheckFn = async () => ({
  collisions: [{ sessionId: 's_2', sessionName: 'other', path: 'src/x.ts', symbol: 'foo', kind: 'function' }],
});

let cwd: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'cw-radar-hook-'));
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'src', 'x.ts'), 'export function foo() {}\n');
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function stdinFor(toolName: string, filePath: string): string {
  return JSON.stringify({
    session_id: 'claude-session-1',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath },
  });
}

describe('runRadarHook', () => {
  test('no collision: allow, no additionalContext', async () => {
    const out = await runRadarHook(stdinFor('Edit', join(cwd, 'src', 'x.ts')), NO_COLLISION);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test('a collision: still allow, but additionalContext names the other session', async () => {
    const out = await runRadarHook(stdinFor('Write', join(cwd, 'src', 'x.ts')), ONE_COLLISION);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('other');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('foo');
  });

  test('a non-Edit/Write tool call is allowed without calling radar.check at all', async () => {
    let called = false;
    const spy: RadarCheckFn = async () => { called = true; return { collisions: [] }; };
    const out = await runRadarHook(stdinFor('Read', join(cwd, 'src', 'x.ts')), spy);
    expect(called).toBe(false);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('malformed stdin still allows rather than blocking the agent', async () => {
    const out = await runRadarHook('not json at all', NO_COLLISION);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('a file_path escaping cwd is allowed without calling radar.check', async () => {
    let called = false;
    const spy: RadarCheckFn = async () => { called = true; return { collisions: [] }; };
    const out = await runRadarHook(stdinFor('Edit', '/etc/passwd'), spy);
    expect(called).toBe(false);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
