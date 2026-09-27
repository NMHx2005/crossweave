import { describe, expect, it } from 'bun:test';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { namesScript, parseShellNames, readShellNames } from '../../src/core/shell-names.js';

describe('parseShellNames', () => {
  // Dotfiles may print banners around what the shell was asked for.
  it('takes only the marked names, one per line', () => {
    expect([...parseShellNames('motd\n__CW_NAMES__cx\nll\n\n  gs \n__CW_NAMES__bye')]).toEqual(['cx', 'll', 'gs']);
    expect(parseShellNames('no markers').size).toBe(0);
  });
});

describe('namesScript', () => {
  it('knows zsh and bash by name, and nothing else', () => {
    expect(namesScript('/bin/zsh')).toContain('${(k)functions}');
    expect(namesScript('/usr/local/bin/bash')).toContain('compgen -A function');
    expect(namesScript('/usr/bin/fish')).toBeUndefined();
  });
});

describe('readShellNames', () => {
  // A launcher whose command is a shell function (a `cx` wrapper around claude) was
  // shown "not installed" and could not be picked, though typing it in the shell works.
  const withHome = async (rc: string, content: string, shell: string): Promise<Set<string>> => {
    const home = mkdtempSync(join(tmpdir(), 'cw-names-'));
    try {
      writeFileSync(join(home, rc), content);
      return await readShellNames(shell, home);
    } finally {
      try { renameSync(home, join(homedir(), '.Trash', `cw-names-${Date.now()}-${Math.random()}`)); } catch { /* left in tmp */ }
    }
  };

  it.skipIf(Bun.which('zsh') === null)('reads zsh aliases and functions from the user\'s dotfiles', async () => {
    const names = await withHome('.zshrc', 'cx() { claude "$@"; }\nalias cc="claude --continue"\n', Bun.which('zsh') as string);
    expect(names.has('cx')).toBe(true);
    expect(names.has('cc')).toBe(true);
  });

  it.skipIf(Bun.which('bash') === null)('reads bash aliases and functions from the user\'s dotfiles', async () => {
    // A login bash reads .bash_profile (which usually sources .bashrc) — as the
    // session's own `$SHELL -l` does, so what is found here is what the session has.
    const names = await withHome('.bash_profile', 'cx() { claude "$@"; }\nalias cc="claude --continue"\n', Bun.which('bash') as string);
    expect(names.has('cx')).toBe(true);
    expect(names.has('cc')).toBe(true);
  });

  it('an unknown or failing shell knows nothing', async () => {
    expect((await readShellNames('/bin/false', tmpdir())).size).toBe(0);
    expect((await readShellNames('/usr/bin/fish-not-here', tmpdir())).size).toBe(0);
  });
});
