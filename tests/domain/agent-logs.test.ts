import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectDir, latestWords } from '../../src/domain/agent-logs.js';

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cw-logs-home-'));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cw-logs-wt.x_')));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

function claudeLog(id: string, texts: string[], ageSec = 0): void {
  const dir = claudeProjectDir(home, cwd);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id}.jsonl`);
  writeFileSync(f, texts.map((t) => line({ type: 'assistant', sessionId: id, message: { content: [{ type: 'text', text: t }] } })).join('')
    + line({ type: 'user', message: { content: 'next' } }));
  const t = new Date(Date.now() - ageSec * 1000);
  utimesSync(f, t, t);
}

describe('Claude Code logs', () => {
  it('names the project dir the way Claude does: every non-alphanumeric becomes a dash', () => {
    expect(claudeProjectDir('/h', '/private/tmp/cw-play/.crossweave/worktrees/s_01AB')).toBe(
      '/h/.claude/projects/-private-tmp-cw-play--crossweave-worktrees-s-01AB',
    );
  });

  it('reads the latest assistant words, on one line and trimmed', () => {
    claudeLog('u1', ['Looking at the tests.', 'Done.\nAll 12 tests pass now,   and the build is green.']);
    expect(latestWords({ home, cwd })).toBe('Done. All 12 tests pass now, and the build is green.');
  });
});

describe('Codex logs', () => {
  function codexLog(name: string, id: string, forCwd: string, text?: string): void {
    const dir = join(home, '.codex', 'sessions', '2026', '09', '26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name),
      line({ type: 'session_meta', payload: { id, cwd: forCwd } })
      + (text ? line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) : ''));
  }

  it('reads the newest rollout whose session_meta cwd is this worktree', () => {
    codexLog('rollout-2026-09-26T10-00-00-a.jsonl', 'id-a', cwd);
    codexLog('rollout-2026-09-26T11-00-00-b.jsonl', 'id-other', '/somewhere/else', 'Not this worktree.');
    codexLog('rollout-2026-09-26T12-00-00-c.jsonl', 'id-c', cwd, 'Patched the parser.');
    expect(latestWords({ home, cwd })).toBe('Patched the parser.');
  });

  // crossweave no longer knows what the user ran: whichever log was written last wins.
  it('takes the most recently written log, Claude or Codex', () => {
    claudeLog('u1', ['From Claude.'], 60);
    codexLog('rollout-2026-09-26T12-00-00-c.jsonl', 'id-c', cwd, 'From Codex.');
    expect(latestWords({ home, cwd })).toBe('From Codex.');
    claudeLog('u2', ['Claude again.'], 0);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(claudeProjectDir(home, cwd), 'u2.jsonl'), later, later);
    expect(latestWords({ home, cwd })).toBe('Claude again.');
  });
});

describe('a worktree with no readable log', () => {
  it('has no latest words', () => {
    expect(latestWords({ home, cwd })).toBeUndefined();
  });
});
