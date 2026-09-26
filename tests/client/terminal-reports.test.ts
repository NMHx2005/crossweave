import { describe, expect, it } from 'bun:test';
import { stripFocusReports, stripTerminalReports } from '../../src/client/terminal-reports.js';

describe('stripTerminalReports', () => {
  // Replaying scrollback into a terminal re-runs the agent's old queries; the
  // terminal answers them, and forwarding those answers typed `^[[?1;2c` into
  // Claude Code's trust prompt.
  it('removes device-attribute, focus and cursor-position reports', () => {
    expect(stripTerminalReports('\x1b[?1;2c')).toBe('');
    expect(stripTerminalReports('\x1b[>0;276;0c')).toBe('');
    expect(stripTerminalReports('\x1b[I\x1b[O')).toBe('');
    expect(stripTerminalReports('\x1b[24;80R')).toBe('');
    expect(stripTerminalReports('\x1b]11;rgb:1616/1919/1d1d\x1b\\')).toBe('');
    expect(stripTerminalReports('\x1b]10;rgb:c9c9/d1d1/d9d9\x07')).toBe('');
  });

  it('keeps everything a person typed, including arrow keys and Enter', () => {
    expect(stripTerminalReports('ls -la\r')).toBe('ls -la\r');
    expect(stripTerminalReports('\x1b[A\x1b[B\x1b[C\x1b[D')).toBe('\x1b[A\x1b[B\x1b[C\x1b[D');
    expect(stripTerminalReports('y\x1b[?1;2c\r')).toBe('y\r');
  });
});

describe('stripFocusReports', () => {
  it('drops focus in/out and nothing else', () => {
    expect(stripFocusReports('\x1b[O\x1b[Iy\r')).toBe('y\r');
    expect(stripFocusReports('\x1b[A\x1b[?1;2c')).toBe('\x1b[A\x1b[?1;2c');
  });
});
