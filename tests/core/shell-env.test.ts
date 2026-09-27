import { describe, expect, test } from 'bun:test';
import { shellEnv } from '../../src/core/shell-env.js';

describe('shellEnv', () => {
  // A daemon started from inside a Claude Code session inherited that session's
  // identity; `claude` run in a crossweave shell then believed it was a child
  // session and turned transcript saving off (and saw the parent's messaging token).
  test('drops an agent session identity inherited from whoever started the daemon', () => {
    const env = shellEnv({
      HOME: '/Users/me',
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_x',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_EXECPATH: '/x',
      CLAUDE_PID: '77',
      CLAUDE_TMPDIR: '/tmp/claude-501',
      CLAUDE_EFFORT: 'medium',
    }, {});
    expect(env).toEqual({ HOME: '/Users/me', PATH: '/usr/bin', TERM: 'xterm-256color' });
  });

  test('keeps configuration, including Claude Code settings the user exports', () => {
    const env = shellEnv({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'opus', LANG: 'en_US.UTF-8' }, {});
    expect(env).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'opus', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' });
  });

  test('what the session asks for wins over what was inherited; identity from a client is dropped too', () => {
    const env = shellEnv({ PORT: '3000', TERM: 'dumb' }, { PORT: '43000', CLAUDECODE: '1', FOO: 'bar' });
    expect(env).toEqual({ PORT: '43000', FOO: 'bar', TERM: 'xterm-256color' });
  });

  test('undefined inherited values are skipped', () => {
    expect(shellEnv({ A: undefined, B: 'b' }, {})).toEqual({ B: 'b', TERM: 'xterm-256color' });
  });
});
