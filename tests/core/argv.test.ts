import { describe, it, expect } from 'bun:test';
import { joinArgs, quoteArg, splitCommand } from '../../src/core/argv.js';

describe('joinArgs', () => {
  it('leaves plain flags bare and quotes the rest', () => {
    expect(joinArgs(['claude', '--model', 'opus', '--dangerously-skip-permissions'])).toBe('claude --model opus --dangerously-skip-permissions');
    expect(quoteArg('hello world')).toBe("'hello world'");
    expect(quoteArg('')).toBe("''");
  });

  // A launch line is shown with joinArgs and read back with splitCommand: whatever
  // was stored must come back unchanged, or a restart would run something else.
  it('round-trips through splitCommand, quotes and all', () => {
    for (const args of [
      ['claude', '--append-system-prompt', "it's \"quoted\" $(not run); rm x"],
      ['codex', '-c', 'a=b c', 'tab\there', ''],
      ['x', 'back\\slash', "'"],
    ]) {
      expect(splitCommand(joinArgs(args))).toEqual(args);
    }
  });
});
