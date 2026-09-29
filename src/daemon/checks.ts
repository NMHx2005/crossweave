import { CrossweaveError } from '../core/errors.js';

export interface CheckDeps {
  /** Run the (trusted) command with `sh -c` in `cwd`; resolves with the exit code and the end of its output. */
  run: (command: string, cwd: string, env: Record<string, string>) => Promise<{ code: number; tail: string }>;
  now?: () => number;
  /** A run started or finished: clients should redraw. */
  onChange: (sessionId: string) => void;
  /** The session's git counts as of now, read when a run ends so the verdict is pinned to the work it judged. */
  markAtFinish?: (sessionId: string, cwd: string) => Promise<GitMark | null>;
}

export interface GitMark { changed: number; ahead: number | null }

export interface CheckState {
  state: 'running' | 'pass' | 'fail';
  /** Epoch ms the run started. */
  at: number;
  /** Duration of a finished run. */
  ms?: number;
  code?: number;
  /** The end of the output of a failed run. */
  tail?: string;
  /** The work moved on since this ran: a lie to show as current. */
  stale: boolean;
}

interface Entry {
  state: 'running' | 'pass' | 'fail';
  at: number;
  finishedAt?: number;
  ms?: number;
  code?: number;
  tail?: string;
  mark: GitMark | null;
}

const TAIL_KEPT = 2000;
/** Activity in the session's terminal this long after a run ended counts as "the code may have changed". */
const ACTIVITY_GRACE_MS = 2000;

/**
 * The verdict of the project's trusted test command run in ONE session's worktree, so the rail can say whether
 * that work is fit to land before anyone opens it. In memory only. The daemon never decides WHAT to run here:
 * the caller passes the command only after the trust gate that `land` uses.
 *
 * A verdict is remembered with the session's git counts at the time; it shows as stale when those change or the
 * terminal was active after the run ended. That errs on the side of "stale" (an agent typing counts): a green
 * tick that no longer describes the code is worse than a dim one.
 */
export class CheckRunner {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: CheckDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  start(sessionId: string, command: string, cwd: string, env: Record<string, string>, mark: GitMark | null): void {
    if (this.entries.get(sessionId)?.state === 'running') {
      throw new CrossweaveError('CHECK_RUNNING', 'A check is already running in this session');
    }
    const entry: Entry = { state: 'running', at: this.now(), mark };
    this.entries.set(sessionId, entry);
    const finish = async (code: number, tail: string): Promise<void> => {
      // The counts as the run ended (best effort): the mark taken when it began may predate an edit made just before.
      const ended = await this.deps.markAtFinish?.(sessionId, cwd).catch(() => null) ?? null;
      // Forgotten (the session ended) or restarted meanwhile: this result is no longer anyone's.
      if (this.entries.get(sessionId) !== entry) return;
      if (ended !== null) entry.mark = ended;
      entry.state = code === 0 ? 'pass' : 'fail';
      entry.code = code;
      entry.finishedAt = this.now();
      entry.ms = entry.finishedAt - entry.at;
      if (code !== 0) entry.tail = tail.slice(-TAIL_KEPT);
      this.deps.onChange(sessionId);
    };
    void this.deps.run(command, cwd, env).then((r) => finish(r.code, r.tail), (err: unknown) => finish(-1, String((err as Error)?.message ?? err)));
    this.deps.onChange(sessionId);
  }

  get(sessionId: string, mark: GitMark | null, lastActivityAt: number | null): CheckState | undefined {
    const e = this.entries.get(sessionId);
    if (e === undefined) return undefined;
    // The counts were not known yet when the run began (they are read in the background): the first ones seen
    // are the baseline, or a fresh verdict would show as stale the moment the counts arrived.
    if (e.mark === null && mark !== null) e.mark = mark;
    const moved = e.state !== 'running' && (
      e.mark?.changed !== mark?.changed || e.mark?.ahead !== mark?.ahead
      || (lastActivityAt !== null && e.finishedAt !== undefined && lastActivityAt > e.finishedAt + ACTIVITY_GRACE_MS)
    );
    return {
      state: e.state, at: e.at, stale: moved,
      ...(e.ms === undefined ? {} : { ms: e.ms }),
      ...(e.code === undefined ? {} : { code: e.code }),
      ...(e.tail === undefined ? {} : { tail: e.tail }),
    };
  }

  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}

const RUN_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_KEPT = 8000;

/**
 * `sh -c command` in `cwd`, stdin closed, stopped after `timeoutMs`. Resolves with the exit code (124 for a
 * timeout, like `timeout(1)`) and the END of stdout+stderr: a test run's verdict is at the bottom.
 */
export async function runShell(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<{ code: number; tail: string }> {
  const proc = Bun.spawn(['sh', '-c', command], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
  try {
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const tail = (out + err).slice(-OUTPUT_KEPT);
    return timedOut ? { code: 124, tail: `${tail}\ntimed out after ${Math.round(timeoutMs / 1000)}s` } : { code, tail };
  } finally {
    clearTimeout(timer);
  }
}
