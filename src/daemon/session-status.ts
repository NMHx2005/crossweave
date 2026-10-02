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
  /** Extra Terminal panes keyed by terminalId, folded into their session's status. */
  private readonly childTracks = new Map<string, Track>();
  private readonly childParent = new Map<string, string>();
  /** session → its panes' terminalIds, so `status`/`sweep` never scan every pane. */
  private readonly bySession = new Map<string, Set<string>>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    /** How long output may pause before the session counts as quiet. */
    private readonly quietMs = 2500,
    /** How long "esc to interrupt" may be gone before the turn counts as over. */
    private readonly busyGraceMs = 1500,
  ) {}

  started(id: string, cols = 80, rows = 24): void {
    this.tracks.get(id)?.screen.dispose();
    this.tracks.set(id, this.freshTrack(cols, rows));
  }

  private freshTrack(cols: number, rows: number): Track {
    return {
      lastOutputAt: null, lastInputAt: null, workedSinceInput: false,
      bellSinceInput: false, failed: false, reported: 'idle',
      screen: new AgentScreen(cols, rows), screenSpoke: false, busySinceInput: false, lastBusyAt: null, signal: null, echoUntil: 0,
    };
  }

  /**
   * An extra Terminal pane of a session (a split): its own shell, therefore its own
   * screen, echo window and bell — and often its own agent. Its track folds into the
   * session's status (see `status`), so an agent the user started in a split pane still
   * moves the rail row.
   *
   * Options object, not positional: sessionId and terminalId are both opaque strings —
   * a swap would typecheck.
   */
  startedTerminal(opts: { sessionId: string; terminalId: string; cols?: number; rows?: number }): void {
    const { sessionId, terminalId, cols = 80, rows = 24 } = opts;
    this.childTracks.get(terminalId)?.screen.dispose();
    this.childTracks.set(terminalId, this.freshTrack(cols, rows));
    this.childParent.set(terminalId, sessionId);
    let ids = this.bySession.get(sessionId);
    if (ids === undefined) {
      ids = new Set();
      this.bySession.set(sessionId, ids);
    }
    ids.add(terminalId);
  }

  terminalOutput(terminalId: string, chunk: string): void {
    const t = this.childTracks.get(terminalId);
    if (t === undefined) return;
    if (this.now() >= t.echoUntil) {
      t.lastOutputAt = this.now();
      t.workedSinceInput = true;
    }
    if (rings(chunk)) t.bellSinceInput = true;
    t.screen.write(chunk);
  }

  terminalInput(terminalId: string, data?: string): void {
    const t = this.childTracks.get(terminalId);
    if (t === undefined) return;
    this.noteInput(t, data);
    // The user is present in this session (they typed in one of its panes): a `cw
    // notify` word left on the row is answered, not pending.
    const parent = this.childParent.get(terminalId);
    if (parent !== undefined) {
      const p = this.tracks.get(parent);
      if (p !== undefined) p.signal = null;
    }
  }

  terminalResized(terminalId: string, cols: number, rows: number): void {
    this.childTracks.get(terminalId)?.screen.resize(cols, rows);
  }

  /** The pane is gone; its shell's exit code must not mark the session `failed`. */
  terminalExited(terminalId: string): void {
    this.childTracks.get(terminalId)?.screen.dispose();
    this.childTracks.delete(terminalId);
    const sessionId = this.childParent.get(terminalId);
    if (sessionId !== undefined) {
      this.childParent.delete(terminalId);
      this.bySession.get(sessionId)?.delete(terminalId);
    }
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
    this.noteInput(t, data);
  }

  /** Shared by a session's own input and an extra pane's input: same echo rules. */
  private noteInput(t: Track, data?: string): void {
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
    // A session's panes are deliberately NOT forgotten here: they are separate shells
    // that may outlive the session's own track (the shell stopped, the panes did not),
    // and the row must not go blind to them. `closeForSession` removes the panes
    // themselves, through the observer, in every removal path.
  }

  /**
   * `terminalAgentOf` is required, not optional: a caller that omits it would silently
   * fold its panes in as agent-less plain shells (screen words unread). Passing one
   * even when no panes exist costs nothing.
   */
  status(id: string, agent: string | null, terminalAgentOf: (terminalId: string) => string | null): SessionStatus {
    const t = this.tracks.get(id);
    // No track (never started, or the daemon restarted and the session has not been):
    // the panes' activity is still the row's truth.
    const own = t === undefined ? { activity: 'idle' as Activity, rang: false } : this.judge(t, agent);
    let activity: Activity = own.activity;
    let rang = own.rang;
    let lastActivityAt = t === undefined ? -1 : Math.max(t.lastOutputAt ?? -1, t.lastInputAt ?? -1);
    for (const terminalId of this.bySession.get(id) ?? []) {
      const child = this.childTracks.get(terminalId);
      if (child === undefined) continue;
      const childStatus = this.judge(child, terminalAgentOf(terminalId));
      // Priority on one row: a session shell that died non-zero > a pane asking for the
      // user (ring/permission prompt) > a pane working > a finished turn > idle. A pane
      // working cannot downgrade an explicit `cw notify` word, though: the signal was
      // the session speaking for itself.
      const signalPresent = t !== undefined && t.signal !== null;
      if (!signalPresent) {
        if (childStatus.rang && activity !== 'failed') {
          activity = 'asked';
          rang = true;
        } else if (childStatus.activity === 'working' && activity !== 'failed' && !rang) {
          activity = 'working';
        } else if (childStatus.activity === 'asked' && activity === 'idle') {
          activity = 'asked';
        }
      }
      lastActivityAt = Math.max(lastActivityAt, child.lastOutputAt ?? -1, child.lastInputAt ?? -1);
    }
    if (t === undefined) return { activity, lastActivityAt: lastActivityAt < 0 ? null : lastActivityAt, rang };
    return { activity, lastActivityAt: lastActivityAt < 0 ? null : lastActivityAt, rang, ...(t.signal === null ? {} : { signal: t.signal }) };
  }

  /** One track's activity and whether it is waiting for the user, not merely done. */
  private judge(t: Track, agent: string | null): { activity: Activity; rang: boolean } {
    const activity = this.activityOf(t, agent);
    // A permission prompt on screen asks as surely as a bell does.
    const rang = t.bellSinceInput || (activity === 'asked' && agent !== null && (t.screenSpoke || SCREEN_AGENTS.has(agent)) && ASKING_ON_SCREEN.test(t.screen.nearCursor()));
    return { activity, rang };
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

  /**
   * Ids whose activity changed since the last sweep. `agentOf` serves the session
   * shells' tracks; `terminalAgentOf` the extra panes' shells (a `t…` id, distinct
   * from a session's `s…`). Sweeping the aggregates keeps one truth: a pane moving a
   * session announces the session, not itself.
   */
  sweep(agentOf: (id: string) => string | null, terminalAgentOf: (terminalId: string) => string | null): string[] {
    const changed: string[] = [];
    for (const [id, t] of this.tracks) {
      const now = this.status(id, agentOf(id), terminalAgentOf).activity;
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
