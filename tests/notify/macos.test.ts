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

  test('a clickCommand element containing $(...) is inert to /bin/sh -c, the shell terminal-notifier re-executes -execute through on click', async () => {
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
    sendMacNotification('crossweave', 'auth blocked', ['cw', 'session', 'attach', 'sym$(echo INJECTED)']);

    const tn = calls.find((c) => c.cmd.includes('terminal-notifier'))!;
    const executeIndex = tn.args.indexOf('-execute');
    const executeValue = tn.args[executeIndex + 1]!;
    expect(executeValue.startsWith('osascript -e ')).toBe(true);

    // Reproduce julienXX/terminal-notifier's own re-exec of -execute's value:
    // `/bin/sh -c <executeValue>` (AppDelegate.m: `task.launchPath = @"/bin/sh";
    // task.arguments = @[@"-c", command]`). Swap the leading `osascript -e` for a
    // harmless `printf '%s'` so we observe exactly what sh hands the command as its
    // argument, without opening a real Terminal window or invoking osascript.
    const probeCommand = executeValue.replace(/^osascript -e /, "printf '%s' ");
    const probeResult = originalChildProcess.execFileSync('/bin/sh', ['-c', probeCommand], { encoding: 'utf8' }) as string;

    // Note: a bare `.toContain('INJECTED')` would prove nothing either way — that
    // substring appears in the safe literal text too (it's the tail of
    // `$(echo INJECTED)`). The actual signal is whether `$(echo INJECTED)` survives
    // *intact* — if sh had performed command substitution (the pre-fix bug), that
    // whole substring would be gone, replaced by just the word `INJECTED` with no
    // `$(echo ` / `)` around it. An exact match against the known-good literal script
    // pins this down precisely: this is character-for-character what `do script`'s
    // AppleScript argument looks like when nothing sh-relevant ever fired.
    const expectedScript =
      'tell application "Terminal" to do script "\'cw\' \'session\' \'attach\' \'sym$(echo INJECTED)\'"\n' +
      'tell application "Terminal" to activate';
    expect(probeResult).toBe(expectedScript);
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
