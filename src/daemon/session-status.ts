import { AgentScreen, ASKING_ON_SCREEN, BUSY_ON_SCREEN } from './agent-screen.js';

/**
 * What a session is doing, inferred from its shell — crossweave does not launch or
 * configure agents, so it cannot ask them. Four signals, all passive:
 *
 * - the screen: with an agent running, what it shows — "esc to interrupt" while it
 *   works, a permission prompt when it asks (see agent-screen.ts);
 * - output: for a plain shell (or an agent that shows no such words), recent output
 *   means work;
 * - the bell: a terminal's "look at me" (Claude Code rings it when it wants input);
 * - the process tree: which agent CLI, if any, runs under the session's shell.
 *
 * Output alone used to decide for agents too, and Claude Code redrawing its status
 * line while it waited kept a finished session spinning for hours.
 */

export type Activity = 'working' | 'asked' | 'idle' | 'failed';

export interface SessionStatus {
  activity: Activity;
  /** Epoch ms of the last output or input, or null before either. */
  lastActivityAt: number | null;
  /**
   * The session rang the bell since the user last typed: an agent asking (permission,
   * a question) rather than one that finished its turn and went quiet.
   */
  rang: boolean;
  /** What the agent (or a script) said itself with `cw notify`; cleared by the next keystroke. */
  signal?: Signal;
}

export type SignalKind = 'done' | 'ask';
export interface Signal { kind: SignalKind; message: string; at: number }

interface Track {
  lastOutputAt: number | null;
  lastInputAt: number | null;
  /** Output arrived since the user last typed: an agent's turn happened. */
  workedSinceInput: boolean;
  bellSinceInput: boolean;
  failed: boolean;
  /** The status the last sweep reported, to tell what changed. */
  reported: Activity;
  screen: AgentScreen;
  /** The screen showed an agent working at some point: its words can be trusted here. */
  screenSpoke: boolean;
  /** The screen showed it working since the user last typed: a turn, not keystroke echo. */
  busySinceInput: boolean;
  /** When the screen last showed it working (debounces a repaint between frames). */
  lastBusyAt: number | null;
  signal: Signal | null;
  /** Output before this instant is the echo of what the user just typed, not work. */
  echoUntil: number;
}

/**
 * A BEL that ends an OSC sequence (a window title, a cwd report) is a terminator, not
 * a ring; only a bare one asks for the user.
 */
function rings(chunk: string): boolean {
  if (!chunk.includes('\x07')) return false;
  return chunk.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').includes('\x07');
}

/**
 * Agents known to show "esc to interrupt" (or cancel) whenever they work: their screen
 * is trusted from the start. For any other, only once it has shown those words — until
 * then its output is the only sign of work, as for a plain shell.
 */
/** How long after a keystroke its echo can arrive. */
const ECHO_WINDOW_MS = 150;

const SCREEN_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini']);

export class ActivityTracker {
  private readonly tracks = new Map<string, Track>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    /** How long output may pause before the session counts as quiet. */
    private readonly quietMs = 2500,
    /** How long "esc to interrupt" may be gone before the turn counts as over. */
    private readonly busyGraceMs = 1500,
  ) {}

  started(id: string, cols = 80, rows = 24): void {
    this.tracks.get(id)?.screen.dispose();
    this.tracks.set(id, {
      lastOutputAt: null, lastInputAt: null, workedSinceInput: false,
      bellSinceInput: false, failed: false, reported: 'idle',
      screen: new AgentScreen(cols, rows), screenSpoke: false, busySinceInput: false, lastBusyAt: null, signal: null, echoUntil: 0,
    });
  }

  output(id: string, chunk: string): void {
    const t = this.tracks.get(id);
    if (t === undefined) return;
    // The shell echoing the user's own keystrokes is not work; anything it prints once a line is submitted is.
    if (this.now() >= t.echoUntil) {
      t.lastOutputAt = this.now();
      t.workedSinceInput = true;
    }
    if (rings(chunk)) t.bellSinceInput = true;
    t.screen.write(chunk);
  }

  resized(id: string, cols: number, rows: number): void {
    this.tracks.get(id)?.screen.resize(cols, rows);
  }

  /** `data` is what was typed; without it the input is assumed to submit something (the conservative reading). */
  input(id: string, data?: string): void {
    const t = this.tracks.get(id);
    if (t === undefined) return;
    t.lastInputAt = this.now();
    t.echoUntil = data !== undefined && !/[\r\n]/.test(data) ? this.now() + ECHO_WINDOW_MS : 0;
    t.workedSinceInput = false;
    t.bellSinceInput = false;
    t.busySinceInput = false;
    t.signal = null;
  }

  /**
   * An explicit word from the session itself (`cw notify`): exact where the screen is a guess. `ask`
   * rings like a bell would; `done` reads as a finished turn. False when the session is not running.
   */
  signalled(id: string, kind: SignalKind, message: string): boolean {
    const t = this.tracks.get(id);
    if (t === undefined) return false;
    t.signal = { kind, message, at: this.now() };
    t.bellSinceInput = kind === 'ask';
    return true;
  }

  /** `requested`: we stopped it, so its exit code (129 for a hangup) is no failure. */
  exited(id: string, code: number, requested: boolean): void {
    const t = this.tracks.get(id);
    if (t === undefined) return;
    t.failed = code !== 0 && !requested;
    t.lastOutputAt = null;
  }

  forget(id: string): void {
    this.tracks.get(id)?.screen.dispose();
    this.tracks.delete(id);
  }

  status(id: string, agent: string | null): SessionStatus {
    const t = this.tracks.get(id);
    if (t === undefined) return { activity: 'idle', lastActivityAt: null, rang: false };
    const lastActivityAt = Math.max(t.lastOutputAt ?? -1, t.lastInputAt ?? -1);
    const activity = this.activityOf(t, agent);
    // A permission prompt on screen asks as surely as a bell does.
    const rang = t.bellSinceInput || (activity === 'asked' && agent !== null && (t.screenSpoke || SCREEN_AGENTS.has(agent)) && ASKING_ON_SCREEN.test(t.screen.nearCursor()));
    return { activity, lastActivityAt: lastActivityAt < 0 ? null : lastActivityAt, rang, ...(t.signal === null ? {} : { signal: t.signal }) };
  }

  private activityOf(t: Track, agent: string | null): Activity {
    if (t.failed) return 'failed';
    if (t.signal !== null) return 'asked';
    if (agent !== null) {
      const screen = t.screen.nearCursor();
      const now = this.now();
      if (BUSY_ON_SCREEN.test(screen)) {
        t.screenSpoke = true;
        t.busySinceInput = true;
        t.lastBusyAt = now;
      }
      if (t.screenSpoke || SCREEN_AGENTS.has(agent)) {
        if (t.lastBusyAt !== null && now - t.lastBusyAt < this.busyGraceMs) return 'working';
        if (t.bellSinceInput || ASKING_ON_SCREEN.test(screen)) return 'asked';
        // Its turn ended without asking: finished, waiting for your next message
        // ('asked' without `rang` — the cockpit shows it as done).
        return t.busySinceInput ? 'asked' : 'idle';
      }
    }
    if (t.lastOutputAt !== null && this.now() - t.lastOutputAt < this.quietMs) return 'working';
    if (t.bellSinceInput) return 'asked';
    // A plain shell going quiet after `ls` asks nothing; an agent going quiet after
    // its turn is waiting for you.
    if (agent !== null && t.workedSinceInput) return 'asked';
    return 'idle';
  }

  /** Ids whose activity changed since the last sweep. */
  sweep(agentOf: (id: string) => string | null): string[] {
    const changed: string[] = [];
    for (const [id, t] of this.tracks) {
      const now = this.activityOf(t, agentOf(id));
      if (now !== t.reported) {
        t.reported = now;
        changed.push(id);
      }
    }
    return changed;
  }
}

/** Agent CLIs by the binary name they are run as. */
const BINARIES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  gemini: 'gemini',
  agy: 'antigravity',
  antigravity: 'antigravity',
  'cursor-agent': 'cursor',
  copilot: 'copilot',
  aider: 'aider',
  amp: 'amp',
  qwen: 'qwen',
};

/** ...and by the npm package a `node …/cli.js` invocation runs from. */
const PACKAGES: Array<[RegExp, string]> = [
  [/@anthropic-ai\/claude-code\//, 'claude'],
  [/@openai\/codex\//, 'codex'],
  [/@google\/gemini-cli\//, 'gemini'],
  [/\/opencode(?:-ai)?\//, 'opencode'],
  [/@github\/copilot\//, 'copilot'],
  [/@sourcegraph\/amp\//, 'amp'],
  [/@qwen-code\/qwen-code\//, 'qwen'],
];

/** The agent a command line runs, or null. Only the program counts, not its arguments. */
export function agentFromArgs(args: string): string | null {
  const words = args.trim().split(/\s+/);
  const program = (words[0] ?? '').split('/').pop() ?? '';
  const known = BINARIES[program];
  if (known !== undefined) return known;
  // An interpreter running a script: the script's path names the package, or the
  // script is itself named for the agent (a shell wrapper installed as `claude`).
  if (/^(?:node|bun|deno|python3?|sh|bash|zsh)$/.test(program) && words[1] !== undefined) {
    for (const [pattern, agent] of PACKAGES) if (pattern.test(words[1])) return agent;
    const script = words[1].split('/').pop() ?? '';
    return BINARIES[script.replace(/\.(?:js|mjs|cjs)$/, '')] ?? null;
  }
  return null;
}

/**
 * For each session, the agent found anywhere under its shell's pid in one `ps -A -o
 * pid=,ppid=,args=` listing; null when there is none (or the shell is gone).
 */
export function detectAgents(ps: string, shells: ReadonlyMap<string, number>): Map<string, string | null> {
  const children = new Map<number, number[]>();
  const argsOf = new Map<number, string>();
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    argsOf.set(pid, m[3] ?? '');
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out = new Map<string, string | null>();
  for (const [id, shell] of shells) {
    let found: string | null = null;
    // Breadth-first: the agent nearest the shell wins over a helper it spawned.
    const queue = [...(children.get(shell) ?? [])];
    const seen = new Set<number>();
    while (queue.length > 0 && found === null) {
      const pid = queue.shift() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      found = agentFromArgs(argsOf.get(pid) ?? '');
      queue.push(...(children.get(pid) ?? []));
    }
    out.set(id, found);
  }
  return out;
}
