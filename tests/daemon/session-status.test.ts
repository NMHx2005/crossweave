import { describe, it, expect } from 'bun:test';
import { ActivityTracker, agentFromArgs, detectAgents } from '../../src/daemon/session-status.js';
import { BUSY_ON_SCREEN } from '../../src/daemon/agent-screen.js';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('ActivityTracker', () => {
  it('is working while output keeps coming, and idle once a plain shell goes quiet', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    expect(t.status('s', null, () => null).activity).toBe('idle');
    t.input('s');
    t.output('s', 'total 8\r\n');
    expect(t.status('s', null, () => null).activity).toBe('working');
    c.advance(2500);
    // No agent in this shell: `ls` finishing is not a question to the user.
    expect(t.status('s', null, () => null).activity).toBe('idle');
  });

  // For an agent whose screen says nothing about work (aider), its turn ends when its
  // output stops after it worked: it is waiting for you. (Claude Code, Codex and Gemini
  // are read from their screen instead — see 'agents that say when they work' below.)
  it('an agent that stops after working is asking; the next keystroke clears it', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.input('s');
    t.output('s', '⠋ Thinking…');
    c.advance(2500);
    expect(t.status('s', 'aider', () => null).activity).toBe('asked');
    t.input('s');
    expect(t.status('s', 'aider', () => null).activity).toBe('idle');
  });

  it('a bell asks for you, even from a plain shell; a bell that ends an OSC title does not', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.output('s', '\x1b]0;my title\x07prompt$ ');
    c.advance(2500);
    expect(t.status('s', null, () => null).activity).toBe('idle');
    t.output('s', 'done\x07');
    c.advance(2500);
    expect(t.status('s', null, () => null).activity).toBe('asked');
  });

  // "Asked" covers two things: an agent that rang for the user (a permission prompt, a
  // question) and one that simply finished its turn. `rang` tells them apart, so the
  // cockpit can say "waiting for you" for the first and "finished" for the second.
  it('says whether the agent rang since the last keystroke', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.input('s');
    t.output('s', 'working…');
    c.advance(2500);
    expect(t.status('s', 'aider', () => null)).toMatchObject({ activity: 'asked', rang: false });
    t.output('s', 'Allow this edit? \x07');
    c.advance(2500);
    expect(t.status('s', 'aider', () => null)).toMatchObject({ activity: 'asked', rang: true });
    t.input('s');
    expect(t.status('s', 'aider', () => null).rang).toBe(false);
    expect(t.status('unknown', null, () => null).rang).toBe(false);
  });

  it('a shell that died on its own with a failure code has failed; one we stopped has not', () => {
    const t = new ActivityTracker(() => 0, 2000);
    t.started('a');
    t.exited('a', 1, false);
    expect(t.status('a', null, () => null).activity).toBe('failed');
    t.started('b');
    t.exited('b', 129, true);
    expect(t.status('b', null, () => null).activity).toBe('idle');
    // Starting again clears a failure.
    t.started('a');
    expect(t.status('a', null, () => null).activity).toBe('idle');
  });

  it('reports the last output or input time, and which sessions changed since the last sweep', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    expect(t.sweep(() => null, () => null)).toEqual([]);
    t.output('s', 'x');
    expect(t.status('s', null, () => null).lastActivityAt).toBe(c.now());
    expect(t.sweep(() => null, () => null)).toEqual(['s']);
    expect(t.sweep(() => null, () => null)).toEqual([]);
    c.advance(2500);
    expect(t.sweep(() => null, () => null)).toEqual(['s']);
  });
});

/** xterm parses what it is given on a later tick; the screen is read after that. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// The screens below are what the agents draw (Claude Code 2.x, Codex 0.x), cut down.
const CLAUDE_BUSY = '\r\n\x1b[2K✻ Moseying… (4s · ↑ 1.2k tokens · esc to interrupt)\r\n\x1b[2K> \r\n';
const CLAUDE_PROMPT = '\x1b[3A\x1b[J\r\n╭──────╮\r\n│ > │\r\n╰──────╯\r\n  ? for shortcuts\r\n';
const STATUSLINE = '\x1b7\x1b[24;1H\x1b[2Kmain · opus · 42% ctx\x1b8';

describe('ActivityTracker — agents that say when they work', () => {
  // The regression: Claude Code redraws its status line while it waits, and that
  // output alone kept a finished session "working" for hours.
  it('Claude redrawing its status line while it waits is not work', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s', 80, 24);
    t.output('s', CLAUDE_PROMPT);
    for (let i = 0; i < 10; i++) t.output('s', STATUSLINE);
    await settle();
    expect(t.status('s', 'claude', () => null).activity).toBe('idle');
  });

  it('working while "esc to interrupt" is on screen; done (not asking) once it goes', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.input('s');
    t.output('s', CLAUDE_BUSY);
    await settle();
    expect(t.status('s', 'claude', () => null).activity).toBe('working');
    // Minutes of a tool running with no new output: still its turn.
    c.advance(120_000);
    expect(t.status('s', 'claude', () => null).activity).toBe('working');
    t.output('s', CLAUDE_PROMPT);
    for (let i = 0; i < 3; i++) t.output('s', STATUSLINE);
    await settle();
    c.advance(1600);
    expect(t.status('s', 'claude', () => null)).toMatchObject({ activity: 'asked', rang: false });
    // The user starts typing: nothing is waiting any more.
    t.input('s');
    t.output('s', 'h');
    await settle();
    expect(t.status('s', 'claude', () => null).activity).toBe('idle');
  });

  it('a permission prompt on screen asks for the user, bell or no bell', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.input('s');
    t.output('s', CLAUDE_BUSY);
    await settle();
    t.status('s', 'claude', () => null);
    t.output('s', '\x1b[3A\x1b[J Bash command\r\n   rm -rf dist\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n');
    await settle();
    c.advance(1600);
    expect(t.status('s', 'claude', () => null)).toMatchObject({ activity: 'asked', rang: true });
  });

  // Codex repaints only the cells that change: "esc to interrupt" is sent once, then
  // only its timer. Reading the stream, not the screen, lost it after the first frame.
  it('Codex stays working while only its timer repaints', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.input('s');
    t.output('s', '\x1b[22;1H• Working (1s • esc to interrupt)');
    await settle();
    expect(t.status('s', 'codex', () => null).activity).toBe('working');
    for (let i = 2; i < 9; i++) {
      c.advance(1000);
      t.output('s', `\x1b[22;12H${i}`);
      await settle();
      expect(t.status('s', 'codex', () => null).activity).toBe('working');
    }
    t.output('s', '\x1b[22;1H\x1b[2K› ');
    await settle();
    c.advance(1600);
    expect(t.status('s', 'codex', () => null)).toMatchObject({ activity: 'asked', rang: false });
  });

  it('follows the pty size, so a status line on a wide screen is read whole', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 40, 10);
    t.resized('s', 160, 40);
    t.input('s');
    t.output('s', `\x1b[40;1H${' '.repeat(90)}(12s · esc to interrupt)`);
    await settle();
    expect(t.status('s', 'claude', () => null).activity).toBe('working');
  });

  // Claude Code 2.1 (seen live, 2026-09-28): no "esc to interrupt" any more — only the
  // spinner line "✢ Crunching…" while it works, "✻ Churned for 1s · done 1:39 PM" after.
  it('Claude 2.1: working on its spinner line, done once it reads "…ed for"', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 110, 20);
    t.input('s');
    t.output('s', '❯ reply with just the word ok\r\n✢ Crunching… \r\n\r\n────\r\n❯ \r\n────\r\n  📂 s_01 │ [medium] │ Opus 5.5 │ ⏱ 0m\x1b[3A\x1b[3C');
    await settle();
    expect(t.status('s', 'claude', () => null).activity).toBe('working');
    t.output('s', '\x1b[4A\r\x1b[2K⏺ ok\r\n\x1b[2K✻ Churned for 1s · done 1:39 PM\r\n\x1b[2B\x1b[3C');
    for (let i = 0; i < 5; i++) t.output('s', '\x1b7\x1b[20;1H\x1b[2K  📂 s_01 │ $0.02 │ ctx 5%\x1b8');
    await settle();
    c.advance(1600);
    expect(t.status('s', 'claude', () => null)).toMatchObject({ activity: 'asked', rang: false });
  });

  it('text that merely resembles the spinner line is not work', () => {
    for (const line of ['✻ Churned for 1s · done 1:39 PM', '⏺ ok', '❯ reply with just the word ok', '· plain bullet', '* note…']) {
      expect(BUSY_ON_SCREEN.test(line)).toBe(false);
    }
    for (const line of ['✢ Crunching…', '✻ Thinking… (4s · ↑ 1.2k tokens · esc to interrupt)', '* Brewing…', '✽ Running tests…']) {
      expect(BUSY_ON_SCREEN.test(line)).toBe(true);
    }
  });

  // Seen with the real Claude Code: its dialogs end in "Esc to cancel", which is not
  // Gemini's "(esc to cancel, 5s)" — the trust-this-folder dialog showed as working.
  it("Claude's dialogs are questions, not work", async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.output('s', ' Do you trust the files in this folder?\r\n ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n Enter to confirm · Esc to cancel\r\n');
    await settle();
    c.advance(1600);
    expect(t.status('s', 'claude', () => null)).toMatchObject({ activity: 'asked', rang: true });
  });

  it("Gemini's own \"(esc to cancel, 5s)\" is work", async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.input('s');
    t.output('s', '⠏ Thinking about it (esc to cancel, 5s)\r\n> ');
    await settle();
    expect(t.status('s', 'gemini', () => null).activity).toBe('working');
  });

  it('an agent that never shows the words is judged by its output', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s', 80, 24);
    t.input('s');
    t.output('s', 'thinking…');
    await settle();
    expect(t.status('s', 'aider', () => null).activity).toBe('working');
  });
});

describe('ActivityTracker — extra terminals (split panes)', () => {
  // The regression seen live (2026-10-01): an agent typed into an extra Terminal pane
  // of a session never moved the rail — only the session's own pty was tracked.
  const CLAUDE_NARROW = '\r\n✢ Crunching… (2s · esc to interrupt)\r\n❯ \r\n';

  it('an agent working in an extra terminal keeps the session working', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.startedTerminal({ sessionId: 's', terminalId: 't1' });
    expect(t.status('s', null, () => null).activity).toBe('idle');
    t.input('s');
    t.terminalOutput('t1', CLAUDE_NARROW);
    await settle();
    expect(t.status('s', null, () => 'claude')).toMatchObject({ activity: 'working', rang: false });
  });

  it('a permission prompt in an extra terminal asks on the row, bell or no bell', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.startedTerminal({ sessionId: 's', terminalId: 't1' });
    t.terminalInput('t1');
    t.terminalOutput('t1', CLAUDE_NARROW);
    await settle();
    t.terminalOutput('t1', '\x1b[2A\x1b[J Do you want to proceed?\r\n ❯ 1. Yes\r\n');
    await settle();
    c.advance(1600);
    expect(t.status('s', null, () => 'claude')).toMatchObject({ activity: 'asked', rang: true });
  });

  it('once the extra terminal is gone its contribution disappears', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.startedTerminal({ sessionId: 's', terminalId: 't1' });
    t.terminalInput('t1');
    t.terminalOutput('t1', CLAUDE_NARROW);
    await settle();
    c.advance(1600);
    expect(t.status('s', null, () => 'claude').activity).toBe('working');
    t.terminalExited('t1');
    expect(t.status('s', null, () => 'claude').activity).toBe('idle');
  });

  it('the echo of typing in an extra terminal is not work', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.startedTerminal({ sessionId: 's', terminalId: 't1' });
    t.terminalInput('t1', 'l');
    c.advance(5);
    t.terminalOutput('t1', 'l');
    expect(t.status('s', null, () => null).activity).toBe('idle');
  });

  it('a quiet plain shell in an extra terminal does not ask for the user', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.startedTerminal({ sessionId: 's', terminalId: 't1' });
    t.terminalInput('t1');
    t.terminalOutput('t1', 'total 8\r\n');
    c.advance(2500);
    expect(t.status('s', null, () => null)).toMatchObject({ activity: 'idle', rang: false });
  });

  it('sweep reports the session changed when a terminal track moves it', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.startedTerminal({ sessionId: 's', terminalId: 't1' });
    expect(t.sweep(() => null, () => 'claude')).toEqual([]);
    t.terminalInput('t1');
    t.terminalOutput('t1', CLAUDE_NARROW);
    await settle();
    expect(t.sweep(() => null, () => 'claude')).toEqual(['s']);
  });

  it('typing in an extra terminal clears the session\'s cw notify word', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.startedTerminal({ sessionId: 's', terminalId: 't1' });
    t.signalled('s', 'done', 'tests written');
    expect(t.status('s', null, () => null).signal).toBeDefined();
    t.terminalInput('t1');
    expect(t.status('s', null, () => null).signal).toBeUndefined();
  });

  it('a pane asking beats a pane working: the row shows needs-you first', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.startedTerminal({ sessionId: 's', terminalId: 't-working' });
    t.startedTerminal({ sessionId: 's', terminalId: 't-asking' });
    t.terminalInput('t-working');
    t.terminalOutput('t-working', CLAUDE_NARROW);
    await settle();
    t.terminalInput('t-asking');
    t.terminalOutput('t-asking', '\r\n\x1b[2K✻ Moseying… (4s · esc to interrupt)\r\n> \r\n');
    await settle();
    t.terminalOutput('t-asking', '\x1b[2A\x1b[J Do you want to proceed?\r\n ❯ 1. Yes\r\n');
    await settle();
    c.advance(1600);
    // The working pane keeps its busy words on screen (no repaint cleared them), yet
    // the pane that now waits for the user wins the row.
    expect(t.status('s', null, () => 'claude')).toMatchObject({ activity: 'asked', rang: true });
  });

  it('a pane working does not hide that the session shell died on its own', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.startedTerminal({ sessionId: 's', terminalId: 't1' });
    t.terminalInput('t1');
    t.terminalOutput('t1', CLAUDE_NARROW);
    await settle();
    t.exited('s', 1, false);
    expect(t.status('s', null, () => 'claude').activity).toBe('failed');
  });

  it('follows the pane size: a status line on a wide pane is read whole', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.startedTerminal({ sessionId: 's', terminalId: 't1', cols: 40, rows: 10 });
    t.terminalResized('t1', 160, 40);
    t.terminalInput('t1');
    t.terminalOutput('t1', `\x1b[40;1H${' '.repeat(90)}(12s · esc to interrupt)`);
    await settle();
    expect(t.status('s', null, () => 'claude').activity).toBe('working');
  });
});

describe('agentFromArgs', () => {
  it('recognises agent CLIs by binary name and by the npm package they run from', () => {
    expect(agentFromArgs('/Users/me/.local/bin/claude --model opus')).toBe('claude');
    expect(agentFromArgs('node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('claude');
    expect(agentFromArgs('node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')).toBe('codex');
    expect(agentFromArgs('/opt/homebrew/bin/opencode')).toBe('opencode');
    expect(agentFromArgs('node /x/node_modules/@google/gemini-cli/dist/index.js')).toBe('gemini');
    expect(agentFromArgs('agy')).toBe('antigravity');
    expect(agentFromArgs('cursor-agent -p hi')).toBe('cursor');
    expect(agentFromArgs('node /opt/homebrew/lib/node_modules/@github/copilot/index.js')).toBe('copilot');
    expect(agentFromArgs('/Users/me/.local/bin/aider --model sonnet')).toBe('aider');
    // A shell script installed under the agent's name is that agent; any other
    // script (a `cx` wrapper) is not, and the search goes on to what it runs.
    expect(agentFromArgs('/bin/bash /Users/me/.local/bin/claude --resume')).toBe('claude');
    expect(agentFromArgs('/bin/bash /Users/me/bin/cx')).toBeNull();
    expect(agentFromArgs('-zsh')).toBeNull();
    expect(agentFromArgs('vim claude.md')).toBeNull();
  });
});

describe('detectAgents', () => {
  const PS = [
    '  100     1 -zsh',
    '  101   100 /bin/bash /Users/me/bin/cx',
    '  102   101 /Users/me/.local/bin/claude --dangerously-skip-permissions',
    '  200     1 -zsh',
    '  201   200 npm run dev',
    '  202   201 node vite',
    '  300     1 -zsh',
    '  301   300 node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
  ].join('\n');

  // A wrapper script that ends up running claude reads as Claude; a dev server is not an agent.
  it('finds the agent anywhere under each session shell', () => {
    const found = detectAgents(PS, new Map([['a', 100], ['b', 200], ['c', 300], ['gone', 999]]));
    expect(found).toEqual(new Map([['a', 'claude'], ['b', null], ['c', 'codex'], ['gone', null]]));
  });
});

describe('an explicit signal (cw notify)', () => {
  // The screen is a guess; a signal is what the agent (or its hook) says itself.
  it('done: the session shows as finished (asked without a ring), even in a plain shell with no agent', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    expect(t.signalled('s', 'done', 'tests written')).toBe(true);
    const status = t.status('s', null, () => null);
    expect(status.activity).toBe('asked');
    expect(status.rang).toBe(false);
    expect(status.signal).toEqual({ kind: 'done', message: 'tests written', at: c.now() });
  });

  it('ask: it rings, so the row asks for you', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.signalled('s', 'ask', 'which branch?');
    expect(t.status('s', 'claude', () => null)).toMatchObject({ activity: 'asked', rang: true, signal: { kind: 'ask' } });
  });

  it('the next keystroke clears it, like every other wait for the user', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.signalled('s', 'done', 'x');
    t.input('s');
    expect(t.status('s', null, () => null)).toMatchObject({ activity: 'idle', rang: false });
    expect(t.status('s', null, () => null).signal).toBeUndefined();
  });

  it('a session that is not running cannot be signalled', () => {
    const t = new ActivityTracker();
    expect(t.signalled('nope', 'done', 'x')).toBe(false);
  });

  it('a later signal replaces an earlier one and moves its time', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.signalled('s', 'done', 'first');
    c.advance(5000);
    t.signalled('s', 'ask', 'second');
    expect(t.status('s', null, () => null).signal).toEqual({ kind: 'ask', message: 'second', at: c.now() });
  });

  it('is announced as a change so clients redraw', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.sweep(() => null, () => null);
    t.signalled('s', 'done', 'x');
    expect(t.sweep(() => null, () => null)).toEqual(['s']);
  });
});

describe('typing is not work', () => {
  // A plain shell counts as working while it prints; the echo of the user's own keystrokes must not, or a
  // shell with nothing running shows a spinner every time someone types.
  it('the echo of typed characters leaves a plain shell idle', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.input('s', 'l');
    c.advance(5);
    t.output('s', 'l');
    t.input('s', 's');
    c.advance(5);
    t.output('s', 's');
    expect(t.status('s', null, () => null).activity).toBe('idle');
  });

  it('after Enter what the shell prints is a command running: working', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.input('s', 'ls');
    c.advance(5);
    t.output('s', 'ls');
    t.input('s', '\r');
    c.advance(5);
    t.output('s', '\r\ntotal 8\r\n');
    expect(t.status('s', null, () => null).activity).toBe('working');
  });

  it('output that comes on its own, long after the last keystroke, is work', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.input('s', 'x');
    c.advance(1000);
    t.output('s', 'build finished\r\n');
    expect(t.status('s', null, () => null).activity).toBe('working');
  });

  it('a pasted block with a newline in it is a command, not typing', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.input('s', 'echo hi\n');
    c.advance(5);
    t.output('s', 'hi\r\n');
    expect(t.status('s', null, () => null).activity).toBe('working');
  });

  it('an unknown input (no data given) keeps the old rule: its output counts', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.input('s');
    c.advance(5);
    t.output('s', 'something\r\n');
    expect(t.status('s', null, () => null).activity).toBe('working');
  });

  it('the echo of typing does not make an agent look like it worked either', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.input('s', 'h');
    c.advance(5);
    t.output('s', 'h');
    c.advance(3000);
    expect(t.status('s', 'aider', () => null).activity).toBe('idle');
  });
});
