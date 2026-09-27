/**
 * What a session is doing, inferred from its shell — crossweave does not launch or
 * configure agents, so it cannot ask them. Three signals, all passive:
 *
 * - output: agent TUIs animate while they think, so recent output means work;
 * - the bell: a terminal's "look at me" (Claude Code rings it when it wants input);
 * - the process tree: which agent CLI, if any, runs under the session's shell.
 */

export type Activity = 'working' | 'asked' | 'idle' | 'failed';

export interface SessionStatus {
  activity: Activity;
  /** Epoch ms of the last output or input, or null before either. */
  lastActivityAt: number | null;
}

interface Track {
  lastOutputAt: number | null;
  lastInputAt: number | null;
  /** Output arrived since the user last typed: an agent's turn happened. */
  workedSinceInput: boolean;
  bellSinceInput: boolean;
  failed: boolean;
  /** The status the last sweep reported, to tell what changed. */
  reported: Activity;
}

/**
 * A BEL that ends an OSC sequence (a window title, a cwd report) is a terminator, not
 * a ring; only a bare one asks for the user.
 */
function rings(chunk: string): boolean {
  if (!chunk.includes('\x07')) return false;
  return chunk.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').includes('\x07');
}

export class ActivityTracker {
  private readonly tracks = new Map<string, Track>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    /** How long output may pause before the session counts as quiet. */
    private readonly quietMs = 2500,
  ) {}

  started(id: string): void {
    this.tracks.set(id, {
      lastOutputAt: null, lastInputAt: null, workedSinceInput: false,
      bellSinceInput: false, failed: false, reported: 'idle',
    });
  }

  output(id: string, chunk: string): void {
    const t = this.tracks.get(id);
    if (t === undefined) return;
    t.lastOutputAt = this.now();
    t.workedSinceInput = true;
    if (rings(chunk)) t.bellSinceInput = true;
  }

  input(id: string): void {
    const t = this.tracks.get(id);
    if (t === undefined) return;
    t.lastInputAt = this.now();
    t.workedSinceInput = false;
    t.bellSinceInput = false;
  }

  /** `requested`: we stopped it, so its exit code (129 for a hangup) is no failure. */
  exited(id: string, code: number, requested: boolean): void {
    const t = this.tracks.get(id);
    if (t === undefined) return;
    t.failed = code !== 0 && !requested;
    t.lastOutputAt = null;
  }

  forget(id: string): void {
    this.tracks.delete(id);
  }

  status(id: string, agent: string | null): SessionStatus {
    const t = this.tracks.get(id);
    if (t === undefined) return { activity: 'idle', lastActivityAt: null };
    const lastActivityAt = Math.max(t.lastOutputAt ?? -1, t.lastInputAt ?? -1);
    return { activity: this.activityOf(t, agent), lastActivityAt: lastActivityAt < 0 ? null : lastActivityAt };
  }

  private activityOf(t: Track, agent: string | null): Activity {
    if (t.failed) return 'failed';
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
