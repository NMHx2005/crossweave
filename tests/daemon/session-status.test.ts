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
    expect(t.status('s', null).activity).toBe('idle');
    t.input('s');
    t.output('s', 'total 8\r\n');
    expect(t.status('s', null).activity).toBe('working');
    c.advance(2500);
    // No agent in this shell: `ls` finishing is not a question to the user.
    expect(t.status('s', null).activity).toBe('idle');
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
    expect(t.status('s', 'aider').activity).toBe('asked');
    t.input('s');
    expect(t.status('s', 'aider').activity).toBe('idle');
  });

  it('a bell asks for you, even from a plain shell; a bell that ends an OSC title does not', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.output('s', '\x1b]0;my title\x07prompt$ ');
    c.advance(2500);
    expect(t.status('s', null).activity).toBe('idle');
    t.output('s', 'done\x07');
    c.advance(2500);
    expect(t.status('s', null).activity).toBe('asked');
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
    expect(t.status('s', 'aider')).toMatchObject({ activity: 'asked', rang: false });
    t.output('s', 'Allow this edit? \x07');
    c.advance(2500);
    expect(t.status('s', 'aider')).toMatchObject({ activity: 'asked', rang: true });
    t.input('s');
    expect(t.status('s', 'aider').rang).toBe(false);
    expect(t.status('unknown', null).rang).toBe(false);
  });

  it('a shell that died on its own with a failure code has failed; one we stopped has not', () => {
    const t = new ActivityTracker(() => 0, 2000);
    t.started('a');
    t.exited('a', 1, false);
    expect(t.status('a', null).activity).toBe('failed');
    t.started('b');
    t.exited('b', 129, true);
    expect(t.status('b', null).activity).toBe('idle');
    // Starting again clears a failure.
    t.started('a');
    expect(t.status('a', null).activity).toBe('idle');
  });

  it('reports the last output or input time, and which sessions changed since the last sweep', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    expect(t.sweep(() => null)).toEqual([]);
    t.output('s', 'x');
    expect(t.status('s', null).lastActivityAt).toBe(c.now());
    expect(t.sweep(() => null)).toEqual(['s']);
    expect(t.sweep(() => null)).toEqual([]);
    c.advance(2500);
    expect(t.sweep(() => null)).toEqual(['s']);
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
    expect(t.status('s', 'claude').activity).toBe('idle');
  });

  it('working while "esc to interrupt" is on screen; done (not asking) once it goes', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.input('s');
    t.output('s', CLAUDE_BUSY);
    await settle();
    expect(t.status('s', 'claude').activity).toBe('working');
    // Minutes of a tool running with no new output: still its turn.
    c.advance(120_000);
    expect(t.status('s', 'claude').activity).toBe('working');
    t.output('s', CLAUDE_PROMPT);
    for (let i = 0; i < 3; i++) t.output('s', STATUSLINE);
    await settle();
    c.advance(1600);
    expect(t.status('s', 'claude')).toMatchObject({ activity: 'asked', rang: false });
    // The user starts typing: nothing is waiting any more.
    t.input('s');
    t.output('s', 'h');
    await settle();
    expect(t.status('s', 'claude').activity).toBe('idle');
  });

  it('a permission prompt on screen asks for the user, bell or no bell', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.input('s');
    t.output('s', CLAUDE_BUSY);
    await settle();
    t.status('s', 'claude');
    t.output('s', '\x1b[3A\x1b[J Bash command\r\n   rm -rf dist\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n');
    await settle();
    c.advance(1600);
    expect(t.status('s', 'claude')).toMatchObject({ activity: 'asked', rang: true });
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
    expect(t.status('s', 'codex').activity).toBe('working');
    for (let i = 2; i < 9; i++) {
      c.advance(1000);
      t.output('s', `\x1b[22;12H${i}`);
      await settle();
      expect(t.status('s', 'codex').activity).toBe('working');
    }
    t.output('s', '\x1b[22;1H\x1b[2K› ');
    await settle();
    c.advance(1600);
    expect(t.status('s', 'codex')).toMatchObject({ activity: 'asked', rang: false });
  });

  it('follows the pty size, so a status line on a wide screen is read whole', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 40, 10);
    t.resized('s', 160, 40);
    t.input('s');
    t.output('s', `\x1b[40;1H${' '.repeat(90)}(12s · esc to interrupt)`);
    await settle();
    expect(t.status('s', 'claude').activity).toBe('working');
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
    expect(t.status('s', 'claude').activity).toBe('working');
    t.output('s', '\x1b[4A\r\x1b[2K⏺ ok\r\n\x1b[2K✻ Churned for 1s · done 1:39 PM\r\n\x1b[2B\x1b[3C');
    for (let i = 0; i < 5; i++) t.output('s', '\x1b7\x1b[20;1H\x1b[2K  📂 s_01 │ $0.02 │ ctx 5%\x1b8');
    await settle();
    c.advance(1600);
    expect(t.status('s', 'claude')).toMatchObject({ activity: 'asked', rang: false });
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
    expect(t.status('s', 'claude')).toMatchObject({ activity: 'asked', rang: true });
  });

  it("Gemini's own \"(esc to cancel, 5s)\" is work", async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000, 1500);
    t.started('s', 80, 24);
    t.input('s');
    t.output('s', '⠏ Thinking about it (esc to cancel, 5s)\r\n> ');
    await settle();
    expect(t.status('s', 'gemini').activity).toBe('working');
  });

  it('an agent that never shows the words is judged by its output', async () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s', 80, 24);
    t.input('s');
    t.output('s', 'thinking…');
    await settle();
    expect(t.status('s', 'aider').activity).toBe('working');
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
