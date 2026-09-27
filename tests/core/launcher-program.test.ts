import { describe, it, expect } from 'bun:test';
import { launcherProgram } from '../../src/core/launcher-program.js';

describe('launcherProgram', () => {
  // What must be installed for a launcher to run: its command's program, past any
  // leading VAR=value assignments.
  it('finds the program a launcher line runs', () => {
    expect(launcherProgram('claude --model opus')).toBe('claude');
    expect(launcherProgram('ANTHROPIC_MODEL=opus  claude')).toBe('claude');
    expect(launcherProgram("'/opt/my tools/cx' --fast")).toBe('/opt/my tools/cx');
    expect(launcherProgram('   ')).toBeUndefined();
    expect(launcherProgram('FOO=1')).toBeUndefined();
  });
});
