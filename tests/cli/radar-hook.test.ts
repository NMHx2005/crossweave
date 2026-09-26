import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { resolveMainProjectRoot, runRadarHook, runRadarReindexHook, type RadarCheckFn } from '../../src/cli/commands/radar-hook.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

const NO_COLLISION: RadarCheckFn = async () => ({ collisions: [], blocked: false });
const ONE_COLLISION: RadarCheckFn = async () => ({
  collisions: [{ sessionId: 's_2', sessionName: 'other', path: 'src/x.ts', symbol: 'foo', kind: 'function' }],
  blocked: false,
});
const BLOCKED_COLLISION: RadarCheckFn = async () => ({
  collisions: [{ sessionId: 's_2', sessionName: 'other', path: 'src/x.ts', symbol: 'foo', kind: 'function' }],
  blocked: true,
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

  test('a blocked collision: deny, with a reason naming the other session', async () => {
    const out = await runRadarHook(stdinFor('Write', join(cwd, 'src', 'x.ts')), BLOCKED_COLLISION);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('other');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('foo');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('src/x.ts');
  });

  test('a block is never throttled by the noise-control gate, unlike an advisory allow', async () => {
    // The gate caps ADVISORY notifications at 6 per 10 minutes (src/radar/noise.ts).
    // Firing the SAME collision through the hook 7 times in a row proves a block
    // never goes through that gate at all — it must deny every single time.
    for (let i = 0; i < 7; i += 1) {
      const out = await runRadarHook(stdinFor('Write', join(cwd, 'src', 'x.ts')), BLOCKED_COLLISION);
      expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });

  test('blocked with an empty collisions array (defensive, currently unreachable via the real RPC) still denies with a generic reason, not a crash', async () => {
    const EMPTY_BUT_BLOCKED: RadarCheckFn = async () => ({ collisions: [], blocked: true });
    const out = await runRadarHook(stdinFor('Write', join(cwd, 'src', 'x.ts')), EMPTY_BUT_BLOCKED);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('Retry the edit');
  });

  test('a non-Edit/Write tool call is allowed without calling radar.check at all', async () => {
    let called = false;
    const spy: RadarCheckFn = async () => { called = true; return { collisions: [], blocked: false }; };
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
    const spy: RadarCheckFn = async () => { called = true; return { collisions: [], blocked: false }; };
    const out = await runRadarHook(stdinFor('Edit', '/etc/passwd'), spy);
    expect(called).toBe(false);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('runRadarHook: the Bash path is advisory only', () => {
  // Each test needs its OWN collision path and symbol: the hook's notification gate
  // is module-scoped and coalesces per (cwd, path, symbol) for 10 minutes, so two
  // tests sharing a key would make the second silently advisory-free — which is
  // itself the behaviour the coalescing test below pins on purpose.
  const collisionOn = (path: string): RadarCheckFn => async () => ({
    collisions: [{ sessionId: 's_2', sessionName: 'other', path, symbol: 'bar', kind: 'function' }],
    blocked: false,
  });

  function bashStdin(command: string): string {
    return JSON.stringify({
      session_id: 'claude-session-1', cwd, hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command },
    });
  }

  test('a redirect into a file another session also changed advises, and says out loud that it cannot block', async () => {
    const seen: string[] = [];
    const spy: RadarCheckFn = async (_cwd, path) => {
      seen.push(path);
      return { collisions: [{ sessionId: 's_2', sessionName: 'other', path, symbol: 'bar', kind: 'function' }], blocked: false };
    };
    const out = await runRadarHook(bashStdin('sed -i s/a/b/ src/x.ts'), spy);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('other');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('src/x.ts');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('cannot block a write made through Bash');
    expect(seen).toEqual([join('src', 'x.ts')]);
  });

  test('a `blocked` verdict is IGNORED here — a deny built on a parsed guess is not a policy anyone agreed to', async () => {
    const out = await runRadarHook(bashStdin('echo hi > src/x.ts'), BLOCKED_COLLISION);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBeUndefined();
  });

  test('a command with nothing path-like makes no RPC call at all', async () => {
    let called = false;
    const spy: RadarCheckFn = async () => {
      called = true;
      return { collisions: [{ sessionId: 's_2', sessionName: 'other', path: 'src/unreached.ts', symbol: 'bar', kind: 'function' }], blocked: false };
    };
    const out = await runRadarHook(bashStdin('bun test && git status'), spy);
    expect(called).toBe(false);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('a target outside the worktree is dropped rather than checked', async () => {
    const seen: string[] = [];
    const spy: RadarCheckFn = async (_cwd, path) => {
      seen.push(path);
      return { collisions: [{ sessionId: 's_2', sessionName: 'other', path, symbol: 'bar', kind: 'function' }], blocked: false };
    };
    const out = await runRadarHook(bashStdin('tee /etc/hosts'), spy);
    expect(seen).toEqual([]);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('the advisory spends the noise budget a block never touches: a repeat of the same write coalesces', async () => {
    const spy = collisionOn('src/coalesce-me.ts');
    const first = JSON.parse(await runRadarHook(bashStdin('echo hi > src/coalesce-me.ts'), spy));
    const second = JSON.parse(await runRadarHook(bashStdin('echo hi > src/coalesce-me.ts'), spy));
    expect(first.hookSpecificOutput.additionalContext).toBeDefined();
    expect(second.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test('malformed tool_input on the Bash path allows rather than throwing', async () => {
    const stdin = JSON.stringify({ cwd, tool_name: 'Bash', tool_input: {} });
    expect(JSON.parse(await runRadarHook(stdin, NO_COLLISION)).hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('runRadarReindexHook (PostToolUse)', () => {
  function postStdin(toolName: string, toolInput: Record<string, unknown>): string {
    return JSON.stringify({ session_id: 'claude-session-1', cwd, tool_name: toolName, tool_input: toolInput });
  }

  test('an Edit reindexes its own file, repo-relative', async () => {
    const calls: Array<[string, string[]]> = [];
    await runRadarReindexHook(postStdin('Edit', { file_path: join(cwd, 'src', 'x.ts') }), async (c, p) => {
      calls.push([c, p]);
    });
    expect(calls).toEqual([[cwd, [join('src', 'x.ts')]]]);
  });

  test('a Bash write reindexes the paths its command named', async () => {
    const calls: Array<[string, string[]]> = [];
    await runRadarReindexHook(postStdin('Bash', { command: 'sed -i s/a/b/ src/x.ts && echo done > out.txt' }), async (c, p) => {
      calls.push([c, p]);
    });
    expect(calls[0]?.[1]).toEqual([join('src', 'x.ts'), 'out.txt']);
  });

  test('a Bash command with no parseable write reindexes nothing — the fs.watch debounce is the fallback, not this', async () => {
    let called = false;
    await runRadarReindexHook(postStdin('Bash', { command: 'bun test' }), async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  test('a tool this hook does not watch is ignored', async () => {
    let called = false;
    await runRadarReindexHook(postStdin('Read', { file_path: join(cwd, 'src', 'x.ts') }), async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  test('a failing reindex is swallowed — a PostToolUse hook must never surface to the agent', async () => {
    await expect(
      runRadarReindexHook(postStdin('Write', { file_path: join(cwd, 'src', 'x.ts') }), async () => {
        throw new Error('daemon unreachable');
      }),
    ).resolves.toBeUndefined();
  });

  test('malformed stdin returns quietly rather than throwing', async () => {
    await expect(runRadarReindexHook('not json', async () => {})).resolves.toBeUndefined();
    await expect(runRadarReindexHook('null', async () => {})).resolves.toBeUndefined();
  });
});

describe('runRadarHook: Radar unreachable', () => {
  const UNREACHABLE: RadarCheckFn = async () => { throw new Error('ECONNREFUSED'); };

  // Fail-open is by design (a crashed hook must not block the agent), but it used to
  // be silent: "no collision" and "could not check" produced identical output, so a
  // T2 session whose daemon died looked enforced when nothing was being checked.
  test('still allows, and says the edit was not checked', async () => {
    const out = JSON.parse(await runRadarHook(stdinFor('Edit', join(cwd, 'src', 'x.ts')), UNREACHABLE, {
      reportUnreachable: () => true,
    }));
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.additionalContext).toContain('NOT checked');
  });

  test('stays quiet when the notice was already given recently', async () => {
    const out = JSON.parse(await runRadarHook(stdinFor('Write', join(cwd, 'src', 'x.ts')), UNREACHABLE, {
      reportUnreachable: () => false,
    }));
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
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
      return { collisions: [], blocked: false };
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
