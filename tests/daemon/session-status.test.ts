import { describe, it, expect } from 'bun:test';
import { ActivityTracker, agentFromArgs, detectAgents } from '../../src/daemon/session-status.js';

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

  // An agent's turn ends when its output stops after it worked: it is waiting for you.
  it('an agent that stops after working is asking; the next keystroke clears it', () => {
    const c = clock();
    const t = new ActivityTracker(c.now, 2000);
    t.started('s');
    t.input('s');
    t.output('s', '⠋ Thinking…');
    c.advance(2500);
    expect(t.status('s', 'claude').activity).toBe('asked');
    t.input('s');
    expect(t.status('s', 'claude').activity).toBe('idle');
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
    expect(t.status('s', 'claude')).toMatchObject({ activity: 'asked', rang: false });
    t.output('s', 'Allow this edit? \x07');
    c.advance(2500);
    expect(t.status('s', 'claude')).toMatchObject({ activity: 'asked', rang: true });
    t.input('s');
    expect(t.status('s', 'claude').rang).toBe(false);
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
