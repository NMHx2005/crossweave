import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { resolveMainProjectRoot, runRadarHook, type RadarCheckFn } from '../../src/cli/commands/radar-hook.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

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
    // Regression: with a non-canonicalized `cwd`, `relative()` produced a path
    // with leading `../` segments instead of `src/x.ts` — this is exactly the
    // assertion that would have caught it.
    expect(parsed.hookSpecificOutput.additionalContext).toContain('src/x.ts');
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

  test('valid JSON that is not an object (e.g. `null`) still allows rather than throwing', async () => {
    const out = await runRadarHook('null', NO_COLLISION);
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

describe('runRadarHook: cwd reached through a symlink', () => {
  let realDir: string;
  let symlinkedCwd: string;

  beforeAll(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cw-radar-hook-sym-'));
    realDir = join(parent, 'real');
    symlinkedCwd = join(parent, 'link');
    await mkdir(join(realDir, 'src'), { recursive: true });
    await writeFile(join(realDir, 'src', 'x.ts'), 'export function foo() {}\n');
    await symlink(realDir, symlinkedCwd, 'dir');
  });

  afterAll(async () => {
    await rm(join(symlinkedCwd, '..'), { recursive: true, force: true });
  });

  test('the computed repo-relative path stays repo-relative, not `../real/...`', async () => {
    let capturedPath: string | undefined;
    const capture: RadarCheckFn = async (_cwd, path) => {
      capturedPath = path;
      return { collisions: [] };
    };
    const stdin = JSON.stringify({
      session_id: 's', cwd: symlinkedCwd, hook_event_name: 'PreToolUse',
      tool_name: 'Edit', tool_input: { file_path: join(symlinkedCwd, 'src', 'x.ts') },
    });
    await runRadarHook(stdin, capture);
    expect(capturedPath).toBe(join('src', 'x.ts'));
  });
});

describe('resolveMainProjectRoot', () => {
  let fixture: GitFixture;
  let worktreePath: string;

  beforeAll(async () => {
    fixture = await makeGitFixture();
    worktreePath = join(tmpdir(), `cw-radar-hook-wt-${process.pid}-${Date.now()}`);
    await $`git worktree add -q -b radar-hook-wt ${worktreePath}`.cwd(fixture.root).quiet();
    worktreePath = realpathSync(worktreePath);
  });

  afterAll(async () => {
    await $`git worktree remove -f ${worktreePath}`.cwd(fixture.root).quiet().nothrow();
    await fixture.cleanup();
  });

  test('from the main repo root, resolves to itself', () => {
    expect(resolveMainProjectRoot(fixture.root)).toBe(fixture.root);
  });

  test('from a linked worktree, resolves to the MAIN repo root, not the worktree', () => {
    expect(resolveMainProjectRoot(worktreePath)).toBe(fixture.root);
  });
});
