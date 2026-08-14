import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';
import { VERSION } from '../../src/core/version.js';

const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
let fx: GitFixture;
let home: string;

async function run(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: fx.root,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr };
}

beforeEach(async () => {
  fx = await makeGitFixture();
  home = mkdtempSync(join(tmpdir(), 'cw-update-check-cli-'));
});
afterEach(async () => {
  await run(['daemon', 'stop'], { HOME: home });
  await fx.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('update check wiring', () => {
  test('a normal command prints an update notice when one is available', async () => {
    // CW_UPDATE_API_BASE is the test seam checker.ts's HTTP call reads —
    // see Task 3's implementation; this points it at a local fake server.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ tag_name: 'v999.0.0' }), { status: 200 }),
    });
    try {
      const r = await run(['init'], { HOME: home, CW_UPDATE_API_BASE: `http://127.0.0.1:${server.port}` });
      expect(r.stdout).toContain('v999.0.0');
      expect(r.stdout).toContain('cw update');
    } finally {
      server.stop(true);
    }
  });

  test('radar-hook never prints an update notice, even when one is available', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ tag_name: 'v999.0.0' }), { status: 200 }),
    });
    try {
      const proc = Bun.spawn([process.execPath, CLI, 'radar-hook'], {
        cwd: fx.root,
        env: { ...process.env, HOME: home, CW_UPDATE_API_BASE: `http://127.0.0.1:${server.port}` },
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      // Real PreToolUse hook stdin contract — see tests/cli/radar-hook.test.ts's
      // `stdinFor` and src/cli/commands/radar-hook.ts's `PreToolUseInput`.
      const hookInput = JSON.stringify({
        session_id: 'claude-session-1',
        cwd: fx.root,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: join(fx.root, 'README.md') },
      });
      proc.stdin.write(hookInput);
      proc.stdin.end();
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      expect(stdout).not.toContain('v999.0.0');
    } finally {
      server.stop(true);
    }
  });

  test('a bare --version prints only the version line, never an update notice', async () => {
    // citty's runMain does NOT process.exit() on its --version branch (unlike --help and
    // the error path), so it falls through to the update-check block same as any other
    // successful command — this must be explicitly skipped. Regression for the gap found
    // in review of this task: `cw --version` leaked the notice after the version line.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ tag_name: 'v999.0.0' }), { status: 200 }),
    });
    try {
      const r = await run(['--version'], { HOME: home, CW_UPDATE_API_BASE: `http://127.0.0.1:${server.port}` });
      expect(r.stdout.trim()).toBe(VERSION);
      expect(r.stdout).not.toContain('v999.0.0');
      expect(r.stdout).not.toContain('cw update');
    } finally {
      server.stop(true);
    }
  });
});
