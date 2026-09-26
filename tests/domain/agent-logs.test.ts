import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectDir, findConversation, latestWords,
} from '../../src/domain/agent-logs.js';

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
const noOpencode = async () => '[]';

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

  it('resumes the newest conversation in this worktree, and none when there is none', async () => {
    expect(await findConversation('claude', { home, cwd, listOpencode: noOpencode })).toBeUndefined();
    claudeLog('old-uuid', ['first'], 60);
    claudeLog('new-uuid', ['second'], 1);
    expect(await findConversation('claude', { home, cwd, listOpencode: noOpencode })).toBe('new-uuid');
  });

  it('reads the latest assistant words, on one line and trimmed', () => {
    claudeLog('u1', ['Looking at the tests.', 'Done.\nAll 12 tests pass now,   and the build is green.']);
    expect(latestWords('claude', { home, cwd })).toBe('Done. All 12 tests pass now, and the build is green.');
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

  it('resumes the newest rollout whose session_meta cwd is this worktree', async () => {
    codexLog('rollout-2026-09-26T10-00-00-a.jsonl', 'id-a', cwd);
    codexLog('rollout-2026-09-26T11-00-00-b.jsonl', 'id-other', '/somewhere/else');
    codexLog('rollout-2026-09-26T12-00-00-c.jsonl', 'id-c', cwd, 'Patched the parser.');
    expect(await findConversation('codex', { home, cwd, listOpencode: noOpencode })).toBe('id-c');
    expect(latestWords('codex', { home, cwd })).toBe('Patched the parser.');
  });
});

describe('OpenCode sessions', () => {
  it('resumes the newest session listed for this directory', async () => {
    const listOpencode = async () => JSON.stringify([
      { id: 'ses_old', directory: cwd, updated: 1 },
      { id: 'ses_elsewhere', directory: '/other', updated: 9 },
      { id: 'ses_new', directory: cwd, updated: 5 },
    ]);
    expect(await findConversation('opencode', { home, cwd, listOpencode })).toBe('ses_new');
  });

  it('treats unreadable output as no conversation', async () => {
    expect(await findConversation('opencode', { home, cwd, listOpencode: async () => 'not json' })).toBeUndefined();
    expect(await findConversation('opencode', { home, cwd, listOpencode: async () => { throw new Error('ENOENT'); } })).toBeUndefined();
  });
});

describe('agents without a known log', () => {
  it('resume nothing and have no latest words', async () => {
    expect(await findConversation('gemini', { home, cwd, listOpencode: noOpencode })).toBeUndefined();
    expect(latestWords('my-agent', { home, cwd })).toBeUndefined();
  });
});
