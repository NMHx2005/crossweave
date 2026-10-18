import { describe, expect, it } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { AgentScreen, SNAPSHOT_SCROLLBACK } from '../../src/daemon/agent-screen.js';

/** Every buffer row, without the trailing blanks, so two terminals compare directly. */
function lines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    out.push((buffer.getLine(i)?.translateToString(true) ?? '').replace(/\s+$/, ''));
  }
  return out;
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function fresh(cols = 80, rows = 24): Terminal {
  return new Terminal({ cols, rows, scrollback: SNAPSHOT_SCROLLBACK, allowProposedApi: true });
}

/** A split-footer TUI: synchronized frames, cursor moves and partial line clears. */
const TUI_STREAM = [
  '\x1b[?2026h\x1b[?25l\x1b[2J\x1b[H',
  'Hanyu  fix/dead-session-verification\r\n',
  '\x1b[3;1H┌──────────────┐\r\n│ chat message │\r\n└──────────────┘',
  '\x1b[5;3H\x1b[38;5;216mĐánh giá tình trạng\r\n',
  '\x1b[3;1H\x1b[2Knew frame replaces the box\r\n',
  '\x1b[?1003h\x1b[?25h\x1b[?2026l',
].join('');

describe('AgentScreen replay snapshot', () => {
  it('keeps a plain shell on the byte-path: no TUI, no snapshot', async () => {
    const screen = new AgentScreen();
    screen.write('echo hello\r\necho hello\r\n');
    expect(screen.isTui).toBe(false);
    expect(await screen.snapshot()).toBeUndefined();
    screen.dispose();
  });

  it('detects a TUI even when the mode escape is split across chunks', async () => {
    const screen = new AgentScreen();
    screen.write('before \x1b[?20');
    screen.write('26h after');
    expect(screen.isTui).toBe(true);
    screen.dispose();
  });

  it('serializes a TUI screen so a fresh terminal shows the same cells', async () => {
    const screen = new AgentScreen(80, 24);
    screen.write(TUI_STREAM);
    expect(screen.isTui).toBe(true);

    const snapshot = await screen.snapshot();
    expect(snapshot).toBeDefined();

    const expected = fresh();
    await write(expected, TUI_STREAM);
    const replayed = fresh();
    await write(replayed, `\x1bc${snapshot}`);

    expect(lines(replayed)).toEqual(lines(expected));
    screen.dispose();
    expected.dispose();
    replayed.dispose();
  });

  it('carries recent scrollback, not just the viewport', async () => {
    const screen = new AgentScreen(40, 10);
    const history = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\r\n');
    screen.write(`\x1b[?2026h${history}\x1b[?2026l`);
    expect(screen.isTui).toBe(true);

    const snapshot = await screen.snapshot();
    expect(snapshot).toBeDefined();

    const expected = fresh(40, 10);
    await write(expected, `\x1b[?2026h${history}\x1b[?2026l`);
    const replayed = fresh(40, 10);
    await write(replayed, `\x1bc${snapshot}`);

    // The source keeps the newest 500 lines; the snapshot must reproduce exactly that.
    expect(lines(replayed).length).toBeGreaterThan(100);
    expect(lines(replayed).slice(-5)).toEqual(lines(expected).slice(-5));
    expect(screen.nearCursor()).toContain('line 599');
    screen.dispose();
    expected.dispose();
    replayed.dispose();
  });
});
