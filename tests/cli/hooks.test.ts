import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHooksAction } from '../../src/cli/commands/hooks.js';

/**
 * The command layer of `cw hooks`: validation refuses BEFORE anything is asked, the
 * confirmation gate refuses a piped run without `--yes`, and the engine runs with the
 * explicit home (never the test runner's). The engine's file behaviour is covered in
 * tests/core/agent-hooks.test.ts; the printed lines are verified in the manual smoke.
 */

let home = '';

beforeEach(() => {
  home = join(tmpdir(), `cw-hooks-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const run = (action: string, agent: string, yes: boolean): Promise<void> =>
  runHooksAction(action, agent, yes, { home, prefix: 'cw' });

describe('cw hooks command', () => {
  it('installs into a real scratch home with --yes, and twice is a no-op', async () => {
    await run('install', 'claude', true);
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toContain('cw notify');
    await run('install', 'claude', true);
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8').match(/cw notify/g)).toHaveLength(2);
  });

  it('a piped run without --yes is CONFIRM_REQUIRED and writes nothing', async () => {
    await expect(run('install', 'claude', false)).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('refuses an unknown agent and gemini with one CODE line, before any confirm', async () => {
    await expect(run('install', 'warp', true)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(run('install', 'gemini', true)).rejects.toMatchObject({ code: 'AGENT_NO_HOOKS' });
    await expect(run('remove', 'gemini', true)).rejects.toMatchObject({ code: 'AGENT_NO_HOOKS' });
    await expect(run('wire', 'claude', true)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
  });
});
