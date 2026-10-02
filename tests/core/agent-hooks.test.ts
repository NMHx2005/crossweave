import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync, statSync, lstatSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installHooks, removeHooks, nodeHooksIo, cwHookPrefix, DONE_NOTIFY, ASK_NOTIFY, DONE_NOTIFY_ARGS,
  type HooksIo,
} from '../../src/core/agent-hooks.js';

const DONE_CMD = DONE_NOTIFY; // 'cw notify --kind done "finished its turn"' with the plain prefix

/**
 * Real files in a scratch home: hook install edits the user's agent configs, so the
 * tests pin the contract on the genuine article — merge, idempotence, refusal on a
 * malformed file, remove that takes back only its own entries.
 */

let home = '';

function hooksIo(): HooksIo {
  return nodeHooksIo();
}

const settingsPath = (): string => join(home, '.claude', 'settings.json');
const codexPath = (): string => join(home, '.codex', 'config.toml');
const provenancePath = (): string => join(home, '.crossweave', 'hooks-installed.json');

beforeEach(() => {
  home = join(tmpdir(), `cw-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('cw hooks install — claude', () => {
  it('creates settings.json with a Stop (done) and a Notification (ask) entry', () => {
    const out = installHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    expect(out.status).toBe('ok');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const stop = parsed.hooks.Stop as Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]?.hooks?.[0]?.command).toBe(DONE_NOTIFY);
    const notification = parsed.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    expect(notification[0]?.hooks?.[0]?.command).toBe(ASK_NOTIFY);
    expect((JSON.parse(readFileSync(provenancePath(), 'utf8')) as { agents: Record<string, { file: string }> }).agents.claude?.file).toBe(settingsPath());
  });

  it('merges into an existing settings file and leaves every foreign key alone', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      model: 'opus',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-guard.sh' }] }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-own-stop.sh' }] }],
      },
    }));
    const before = readFileSync(settingsPath(), 'utf8');
    const out = installHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    expect(out.status).toBe('ok');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(parsed.model).toBe('opus');
    expect(parsed.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-guard.sh' }] }]);
    expect(parsed.hooks.Stop).toHaveLength(2);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('my-own-stop.sh');
    expect(parsed.hooks.Stop[1].hooks[0].command).toBe(DONE_NOTIFY);
    // The pre-existing file is preserved as a backup the first time we touch it.
    expect(existsSync(join(home, '.crossweave', 'hooks-backup'))).toBe(true);
    expect(readFileSync(settingsPath(), 'utf8')).not.toBe(before);
  });

  it('is a no-op the second time — no duplicate entries, no rewrite', () => {
    installHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    const afterFirst = readFileSync(settingsPath(), 'utf8');
    const out = installHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    expect(out.status).toBe('noop');
    expect(readFileSync(settingsPath(), 'utf8')).toBe(afterFirst);
  });

  it('refuses a malformed settings.json and leaves it byte-identical', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), '{ "hooks": { ');
    const before = readFileSync(settingsPath(), 'utf8');
    const out = installHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    expect(out).toMatchObject({ status: 'refused', code: 'AGENT_CONFIG_MALFORMED' });
    expect(readFileSync(settingsPath(), 'utf8')).toBe(before);
  });

  it('refuses when hooks.Stop is not a list it can append to', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ hooks: { Stop: 'not-a-list' } }));
    const out = installHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    expect(out).toMatchObject({ status: 'refused', code: 'HOOKS_SHAPE' });
  });
});

describe('cw hooks install — codex', () => {
  it('inserts a top-level notify line before the first section of config.toml', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(codexPath(), 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n');
    const out = installHooks('codex', { home, io: hooksIo(), prefix: 'cw' });
    expect(out.status).toBe('ok');
    const text = readFileSync(codexPath(), 'utf8');
    const notifyLine = text.split('\n').find((l) => l.startsWith('notify ='));
    // TOML basic string: the message's quotes are escaped in the file.
    expect(notifyLine).toContain('notify --kind done');
    expect(notifyLine).toContain('\\"finished its turn\\"');
    // Before the first section: a top-level key after a [table] is a different key.
    expect(text.indexOf('notify =')).toBeLessThan(text.indexOf('[profiles.fast]'));
    expect(text).toContain('model = "gpt-5"');
  });

  it('appends at the end when config.toml has no section yet', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(codexPath(), 'model = "gpt-5"\n');
    installHooks('codex', { home, io: hooksIo(), prefix: 'cw' });
    const text = readFileSync(codexPath(), 'utf8');
    expect(text.split('\n').filter((l) => l.startsWith('notify ='))).toHaveLength(1);
  });

  it('is a no-op when the notify line is already ours, refuses when it is someone else\'s', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(codexPath(), 'model = "gpt-5"\n');
    installHooks('codex', { home, io: hooksIo(), prefix: 'cw' });
    const afterFirst = readFileSync(codexPath(), 'utf8');
    expect(installHooks('codex', { home, io: hooksIo(), prefix: 'cw' }).status).toBe('noop');
    expect(readFileSync(codexPath(), 'utf8')).toBe(afterFirst);
    writeFileSync(codexPath(), 'notify = ["my-own-notify"]\n');
    expect(installHooks('codex', { home, io: hooksIo(), prefix: 'cw' })).toMatchObject({ status: 'refused', code: 'HOOKS_KEY_TAKEN' });
  });

  it('refuses when codex is not on this machine', () => {
    expect(installHooks('codex', { home, io: hooksIo(), prefix: 'cw' })).toMatchObject({ status: 'refused', code: 'AGENT_CONFIG_MISSING' });
  });
});

describe('cw hooks install — closed list', () => {
  it('refuses an unknown agent with the supported list', () => {
    expect(installHooks('warp', { home, io: hooksIo(), prefix: 'cw' })).toMatchObject({ status: 'refused', code: 'INVALID_ARGUMENTS' });
  });

  it('refuses an agent with no hook system, without touching anything', () => {
    const out = installHooks('gemini', { home, io: hooksIo(), prefix: 'cw' });
    expect(out).toMatchObject({ status: 'refused', code: 'AGENT_NO_HOOKS' });
    expect(existsSync(join(home, '.crossweave', 'hooks-installed.json'))).toBe(false);
  });
});

describe('cw hooks install — the file itself', () => {
  it('preserves the file mode across an atomic write: 0600 stays 0600', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ model: 'opus' }));
    chmodSync(settingsPath(), 0o600);
    installHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
  });

  it('a foreign multiline TOML array is detected: no duplicate notify key is inserted', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(codexPath(), 'model = "gpt-5"\nnotify = [\n  "my-own",\n  "args",\n]\n');
    const out = installHooks('codex', { home, io: hooksIo(), prefix: 'cw' });
    expect(out).toMatchObject({ status: 'refused', code: 'HOOKS_KEY_TAKEN' });
    expect((readFileSync(codexPath(), 'utf8').match(/notify\s*=/g) ?? []).length).toBe(1);
  });

  it('the hook command quotes a cw path with spaces and quotes in it', () => {
    const weird = join(home, 'my tools', "cw'x");
    const script = `${weird}/cli/index.ts`;
    mkdirSync(join(weird, '..', '.claude'), { recursive: true });
    const out = installHooks('claude', { home, io: hooksIo(), prefix: `bun ${script}` });
    expect(out.status).toBe('ok');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const command = (parsed.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>)[0]?.hooks?.[0]?.command ?? '';
    // Each word quoted for sh; the fixed args string survives verbatim.
    expect(command).toBe(`bun '${script.replaceAll("'", `'\\''`)}' ${DONE_NOTIFY_ARGS}`);
  });
});

describe('cw hooks remove', () => {
  it('takes back exactly its own entries; a user\'s own Stop hook survives', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-own-stop.sh' }] }] },
    }));
    installHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    const out = removeHooks('claude', { home, io: hooksIo() });
    expect(out.status).toBe('ok');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0]?.hooks?.[0]?.command).toBe('my-own-stop.sh');
    expect(parsed.hooks.Notification).toBeUndefined();
    expect(JSON.parse(readFileSync(provenancePath(), 'utf8')).agents.claude).toBeUndefined();
  });

  it('strips only our commands from an entry that bundles ours with the user\'s', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [
        { type: 'command', command: DONE_NOTIFY },
        { type: 'command', command: 'my-own-stop.sh' },
      ] }] },
    }));
    installHooks('claude', { home, io: hooksIo(), prefix: 'cw' }); // no-op for Stop, adds Notification
    const out = removeHooks('claude', { home, io: hooksIo() });
    expect(out.status).toBe('ok');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const stop = parsed.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]?.hooks?.map((h) => h.command)).toEqual(['my-own-stop.sh']);
  });

  it('works across a prefix change: installed from source, removed via the PATH binary', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    // The prefix does not matter for matching: our fixed argument string identifies us.
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `bun /some/where/cli/index.ts ${DONE_NOTIFY}` }] }] },
    }));
    const out = removeHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    expect(out.status).toBe('ok');
    expect((JSON.parse(readFileSync(settingsPath(), 'utf8')) as { hooks?: { Stop?: unknown } }).hooks?.Stop).toBeUndefined();
  });

  it('removes the containers it created when the user had none', () => {
    installHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    removeHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(parsed.hooks?.Stop).toBeUndefined();
    expect(parsed.hooks?.Notification).toBeUndefined();
  });

  it('is a no-op when nothing of ours is there', () => {
    expect(removeHooks('claude', { home, io: hooksIo(), prefix: 'cw' })).toMatchObject({ status: 'noop' });
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(codexPath(), 'model = "gpt-5"\n');
    installHooks('codex', { home, io: hooksIo(), prefix: 'cw' });
    removeHooks('codex', { home, io: hooksIo(), prefix: 'cw' });
    expect(readFileSync(codexPath(), 'utf8')).not.toContain('cw notify');
    expect(removeHooks('codex', { home, io: hooksIo(), prefix: 'cw' })).toMatchObject({ status: 'noop' });
  });

  it('removes the codex notify line it added, before the first section', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(codexPath(), 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "mini"\n');
    installHooks('codex', { home, io: hooksIo(), prefix: 'cw' });
    removeHooks('codex', { home, io: hooksIo(), prefix: 'cw' });
    expect(readFileSync(codexPath(), 'utf8')).not.toContain('notify =');
    expect(readFileSync(codexPath(), 'utf8')).toContain('[profiles.fast]');
  });
});

describe('cwHookPrefix', () => {
  it('resolves the running cw: a source .ts needs bun back, a binary stands alone, the unknown falls back to PATH', () => {
    expect(cwHookPrefix(undefined)).toBe('cw');
    expect(cwHookPrefix('')).toBe('cw');
    const script = join(home, 'cli', 'index.ts');
    mkdirSync(join(home, 'cli'), { recursive: true });
    writeFileSync(script, '// entry\n');
    expect(cwHookPrefix(script)).toBe(`bun ${script}`);
    const binary = join(home, 'cw-bin');
    writeFileSync(binary, '#!/bin/sh\n');
    expect(cwHookPrefix(binary)).toBe(binary);
    expect(cwHookPrefix(join(home, 'gone'))).toBe('cw');
  });
});

describe('the file itself, part 2', () => {
  it('a symlinked settings file stays a symlink: the target is written, the link kept', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const real = join(home, 'dotfiles', 'settings.json');
    mkdirSync(join(home, 'dotfiles'), { recursive: true });
    writeFileSync(real, JSON.stringify({ model: 'opus' }));
    symlinkSync(real, settingsPath());
    const out = installHooks('claude', { home, io: hooksIo(), prefix: 'cw' });
    expect(out.status).toBe('ok');
    expect(lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
    const parsed = JSON.parse(readFileSync(real, 'utf8'));
    expect(parsed.model).toBe('opus');
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it('a one-word prefix whose path contains a space is quoted whole', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const out = installHooks('claude', { home, io: hooksIo(), prefix: '/Users/me/My App/cw' });
    expect(out.status).toBe('ok');
    const command = (JSON.parse(readFileSync(settingsPath(), 'utf8')).hooks.Stop as Array<{ hooks: Array<{ command: string }> }>)[0]?.hooks?.[0]?.command ?? '';
    expect(command.startsWith(`'/Users/me/My App/cw' notify`)).toBe(true);
  });
});
