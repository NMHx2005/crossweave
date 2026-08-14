import { describe, expect, test, mock, afterEach } from 'bun:test';
import * as realChildProcess from 'node:child_process';

// `mock.module` replaces 'node:child_process' globally for the whole `bun test`
// process, not just this file, by mutating the already-imported module's export
// cache in place — without restoring it, every test file that runs after this one
// (e.g. anything spawning git or the daemon) inherits our `execFileSync` stub
// instead of the real one. Snapshot the real exports into a plain object *before*
// any mock.module call runs, since the live namespace binding above gets mutated
// too and can't be used to restore itself. Put the snapshot back after each test
// so the mock never outlives this file.
const originalChildProcess = { ...realChildProcess };
afterEach(() => {
  mock.module('node:child_process', () => originalChildProcess);
});

describe('sendMacNotification argv construction', () => {
  test('terminal-notifier present, with a click command: -execute opens Terminal via argv, no shell string', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    mock.module('node:child_process', () => ({
      execFileSync: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === 'which') return 'Users/x/bin/terminal-notifier\n';
        return '';
      },
    }));
    const { sendMacNotification, __resetTerminalNotifierCacheForTests } = await import('../../src/notify/macos.js');
    __resetTerminalNotifierCacheForTests();
    sendMacNotification('crossweave', 'auth blocked', ['cw', 'session', 'attach', 'auth']);

    const tn = calls.find((c) => c.cmd.includes('terminal-notifier'));
    expect(tn).toBeDefined();
    expect(tn!.args).toContain('-title');
    expect(tn!.args).toContain('crossweave');
    expect(tn!.args).toContain('-message');
    expect(tn!.args).toContain('auth blocked');
    expect(tn!.args).toContain('-execute');
    // The click command is never concatenated into one shell string element —
    // 'cw session attach auth' as a single joined string would fail this.
    expect(tn!.args).not.toContain('cw session attach auth');
  });

  test('terminal-notifier absent: falls back to osascript, passive only', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    mock.module('node:child_process', () => ({
      execFileSync: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === 'which') throw new Error('not found');
        return '';
      },
    }));
    const { sendMacNotification, __resetTerminalNotifierCacheForTests } = await import('../../src/notify/macos.js');
    __resetTerminalNotifierCacheForTests();
    sendMacNotification('crossweave', 'auth blocked', ['cw', 'session', 'attach', 'auth']);

    expect(calls.some((c) => c.cmd === 'osascript')).toBe(true);
    expect(calls.some((c) => c.cmd.includes('terminal-notifier'))).toBe(false);
  });

  test('a message containing a double-quote does not break the osascript argv', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    mock.module('node:child_process', () => ({
      execFileSync: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === 'which') throw new Error('not found');
        return '';
      },
    }));
    const { sendMacNotification, __resetTerminalNotifierCacheForTests } = await import('../../src/notify/macos.js');
    __resetTerminalNotifierCacheForTests();
    expect(() => sendMacNotification('crossweave', 'auth ↔ "payments": src/x.ts', undefined)).not.toThrow();
    const osa = calls.find((c) => c.cmd === 'osascript')!;
    // The raw message text is one argv element among osascript's args, never
    // hand-concatenated into the `-e` script string outside of AppleScript's own
    // string-literal escaping.
    expect(osa.args.some((a) => a.includes('auth ↔ "payments": src/x.ts'))).toBe(false);
  });
});

describe('platformSend', () => {
  test('returns sendMacNotification on darwin', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const { platformSend, sendMacNotification } = await import('../../src/notify/macos.js');
      expect(platformSend()).toBe(sendMacNotification);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  test('returns a no-op on a non-darwin platform', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const { platformSend } = await import('../../src/notify/macos.js');
      expect(() => platformSend()('t', 'm', undefined)).not.toThrow();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});
