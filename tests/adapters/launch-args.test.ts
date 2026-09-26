import { describe, it, expect } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudePtyAdapter } from '../../src/adapters/claude-pty.js';
import { CliPtyAdapter } from '../../src/adapters/cli-pty.js';
import { profileFor, validateLaunchArgs } from '../../src/adapters/catalog.js';
import type { AgentProcess } from '../../src/adapters/types.js';

async function argvOf(proc: AgentProcess): Promise<string[]> {
  let buf = '';
  proc.onData((c) => { buf += c; });
  await new Promise<number>((res) => proc.onExit(res));
  return buf.replace(/\r/g, '').split('\n').filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4));
}
const ECHO = ['-c', 'for a in "$@"; do echo "ARG:$a"; done', '_'];

describe('validateLaunchArgs', () => {
  it('accepts ordinary flags and returns them', () => {
    expect(validateLaunchArgs('claude', ['--model', 'opus', '--dangerously-skip-permissions'])).toEqual(['--model', 'opus', '--dangerously-skip-permissions']);
    expect(validateLaunchArgs('codex', [])).toEqual([]);
  });

  it('refuses anything but a bounded list of strings', () => {
    for (const bad of ['--model opus', [1], ['a\0b'], ['x'.repeat(5000)], Array.from({ length: 65 }, () => 'a')]) {
      expect(() => validateLaunchArgs('codex', bad)).toThrow(expect.objectContaining({ code: 'INVALID_LAUNCH_ARGS' }));
    }
  });

  // crossweave's --settings carries the Radar hook: a user one could switch T2 off.
  it('keeps --settings for crossweave on Claude, and only on Claude', () => {
    for (const bad of [['--settings', '{}'], ['--settings={}']]) {
      expect(() => validateLaunchArgs('claude', bad)).toThrow(expect.objectContaining({ code: 'INVALID_LAUNCH_ARGS' }));
    }
    expect(validateLaunchArgs('codex', ['--settings', 'x'])).toEqual(['--settings', 'x']);
  });
});

describe('adapters append launch flags', () => {
  it('Claude: the flags come before the Radar hook settings, which stay last', async () => {
    const adapter = new ClaudePtyAdapter('sh', ECHO);
    const argv = await argvOf(adapter.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24, extraArgs: ['--model', 'opus'] }));
    expect(argv.slice(0, 2)).toEqual(['--model', 'opus']);
    expect(argv.at(-2)).toBe('--settings');
  });

  it('a CLI agent gets them after its configured command, and after `resume <id>`', async () => {
    const plain = new CliPtyAdapter('mine', ['sh', ...ECHO, '--base'], profileFor('mine'));
    expect(await argvOf(plain.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24, extraArgs: ['--x'] }))).toEqual(['--base', '--x']);
    // A codex stand-in: `codex resume <id>` is a subcommand, so it must come first.
    const dir = mkdtempSync(join(tmpdir(), 'cw-launch-'));
    try {
      const fakeCodex = join(dir, 'codex');
      writeFileSync(fakeCodex, '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\n');
      chmodSync(fakeCodex, 0o755);
      const codexLike = new CliPtyAdapter('codex', [fakeCodex, '-c', 'x=1'], profileFor('codex'));
      const argv = await argvOf(codexLike.spawn({ cwd: tmpdir(), env: {}, cols: 80, rows: 24, resumeId: 'r1', extraArgs: ['--full-auto'] }));
      expect(argv).toEqual(['resume', 'r1', '-c', 'x=1', '--full-auto']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
