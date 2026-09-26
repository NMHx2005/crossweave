import { describe, it, expect } from 'bun:test';
import { splitCommand } from '../../src/core/argv.js';

describe('splitCommand', () => {
  // Run as argv, never through a shell: quoting is honoured, but `;`, `$(…)` and
  // friends are just characters in an argument.
  it('splits on whitespace and honours quotes and escapes', () => {
    expect(splitCommand('subl "{file}:{line}"')).toEqual(['subl', '{file}:{line}']);
    expect(splitCommand(`ed --msg "hello world" --x 'a b' c\\ d`)).toEqual(['ed', '--msg', 'hello world', '--x', 'a b', 'c d']);
    expect(splitCommand('echo $(whoami); rm x')).toEqual(['echo', '$(whoami);', 'rm', 'x']);
  });

  it('rejects an empty command and unbalanced quotes', () => {
    expect(() => splitCommand('   ')).toThrow(/empty/i);
    expect(() => splitCommand('ed "open')).toThrow(/quote/i);
  });
});
