import { describe, expect, test } from 'bun:test';
import { shellEnv, withoutNoColourSwitch } from '../../src/core/shell-env.js';

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

  // The cockpit launched from Finder (or from Apple Terminal, which sets it) carried
  // NO_COLOR=1 into the daemon, and from there into every session shell: Claude Code
  // printed with no colour at all (0 colour sequences where a fresh launch prints 80),
  // Codex most of its own, while OpenCode ignored it — the same window, some panes
  // grey and some not.
  test('does not pass the launcher\'s "no colour" switch into a session shell', () => {
    const env = shellEnv({ NO_COLOR: '1', TERM: 'dumb', COLORTERM: 'truecolor', HOME: '/Users/me' }, {});
    expect(env).toEqual({ COLORTERM: 'truecolor', HOME: '/Users/me', TERM: 'xterm-256color' });
  });

  test('the same holds for FORCE_COLOR=0, which chalk reads the same way', () => {
    expect(shellEnv({ FORCE_COLOR: '0' }, {}).FORCE_COLOR).toBeUndefined();
    expect(shellEnv({ FORCE_COLOR: 'false' }, {}).FORCE_COLOR).toBeUndefined();
    // A launcher that asks for colour is not fighting the pane; keep it.
    expect(shellEnv({ FORCE_COLOR: '1' }, {}).FORCE_COLOR).toBe('1');
  });

  test('a launcher configured to turn colour off still gets its way, because that is the user saying so', () => {
    expect(shellEnv({ NO_COLOR: '1' }, { NO_COLOR: '1' }).NO_COLOR).toBe('1');
  });
});

describe('withoutNoColourSwitch', () => {
  // The second door: `cw session resume` forwards its whole environment as the
  // session's own, so the switch arrives labelled as the user's rather than inherited.
  test('drops the switches a client forwards from its own terminal', () => {
    expect(withoutNoColourSwitch({ NO_COLOR: '1', NODE_DISABLE_COLORS: '1', FORCE_COLOR: '0', TERM: 'dumb', HOME: '/Users/me' }))
      .toEqual({ TERM: 'dumb', HOME: '/Users/me' });
  });

  test('keeps a launcher asking for colour', () => {
    expect(withoutNoColourSwitch({ FORCE_COLOR: '1' })).toEqual({ FORCE_COLOR: '1' });
  });

  test('leaves everything else alone', () => {
    const env = { PATH: '/usr/bin', CLAUDE_CODE_USE_BEDROCK: '1', NO_COLORISH: 'kept' };
    expect(withoutNoColourSwitch(env)).toEqual(env);
  });
});
