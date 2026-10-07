/**
 * Build/test error lines seen in a session's terminal stream, for the debug bundle
 * (`cw debug`, the Debug tab). A HEURISTIC — labelled as one wherever shown: the
 * shapes below are what common toolchains print, not a parser of any of them.
 *
 * Budget per session, in RAM only (debug state, not history — it dies with the
 * daemon): a ring bounded by count AND bytes, deduped by a normalised key so one
 * error repeated by a watcher is one entry. Numbers and timings are normalised away:
 * the same error at 12 ms and 987 ms is one error.
 */

export interface ErrorLine {
  line: string;
  at: number;
}

/** Colour, cursor movement and OSC sequences — the words matter, not the paint. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

const ERROR_SHAPES: RegExp[] = [
  /\berror TS\d+:/,                        // TypeScript (not anchored: a tell log line may prefix it)
  /:\d+:\d+:\s*(?:fatal )?error:/,         // gcc/clang diagnostics
  /\berror:\d+:/,                          // eslint / runtime 'file:line' styles
  /^error:/,                               // the plain 'error: …' line, first thing ("no error: none" is not)
  /\bERROR\b[:!\s]/,                       // generic UPPERCASE ERROR lines
  /\bERR!/,                                // npm ERR!
  /\bTraceback \(most recent call last\)/, // Python
  /^\s*(?:FAIL|FAILED)\b/,                 // test runners
  /[✗✖✕]\s/,                               // their glyphs
  /\bSegmentation fault\b/,
  /\berror\[E\d+\]:/,                      // Rust
  /^panic:/,                               // Go
  /^--- FAIL:/,                            // go test
  /^\s*(?:Uncaught\s+)?[A-Z][A-Za-z]*(?:Error|Exception):\s/, // Node / JVM / Python exception lines (a colon, so "the TypeError section" is prose)
  /^npm error\b/,                          // npm 7+ prints lowercase, without the "ERR!"
  /^Exception in thread\b/,                // JVM
  /^E {2,}\S/,                             // pytest's failure detail ("E2E suite" is not)
  /\bcommand not found\b/,                 // the shell's own verdict
];

/** One already-stripped line; the heuristic of record. */
export function errorLineOf(line: string): boolean {
  return ERROR_SHAPES.some((p) => p.test(line));
}

/**
 * The dedupe key: bare digit runs (counts, times, positions) collapse; a digit run
 * attached to a word keeps WHOLE — the TypeScript code TS2345 must stay distinct
 * from TS2322, or one error code would hide the other.
 */
export function normalizeErrorKey(line: string): string {
  return line.replace(/([A-Za-z])\d+|\d+/g, (m, letter: string | undefined) => (letter === undefined ? '#' : m)).trim();
}

export interface ErrorLinesOptions {
  /** Epoch source, injected so tests never wait. */
  now?: () => number;
  /** Ring bounds: 50 lines / 8 KB per session. */
  maxLines?: number;
  maxBytes?: number;
  /**
   * The unfinished-line buffer's cap: a process that never prints a terminator
   * (\r-only progress bars, one giant line) must not grow it for the daemon's life.
   * Over the cap the buffer is judged as-is (it dies with the daemon anyway).
   */
  pendingCap?: number;
}

const DEFAULT_MAX_LINES = 50;
const DEFAULT_MAX_BYTES = 8 * 1024;
const DEFAULT_PENDING_CAP = 64 * 1024;

interface Entry { line: string; key: string; at: number; bytes: number }

export class ErrorLines {
  private readonly sessions = new Map<string, { entries: Entry[]; bytes: number; pending: string }>();
  private readonly now: () => number;
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly pendingCap: number;

  constructor(opts: ErrorLinesOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.pendingCap = opts.pendingCap ?? DEFAULT_PENDING_CAP;
  }

  /** Feed one output chunk; \n AND lone \r end a line (progress bars redraw with \r). */
  observe(sessionId: string, chunk: string): void {
    const s = this.sessions.get(sessionId) ?? { entries: [], bytes: 0, pending: '' };
    this.sessions.set(sessionId, s);
    const whole = (s.pending + chunk).split(/\r\n|\n|\r/);
    s.pending = whole.pop() ?? '';
    if (s.pending.length > this.pendingCap) {
      // Judge the tail (the head is long gone by the time the line ends, if ever).
      whole.push(s.pending.slice(-this.pendingCap));
      s.pending = '';
    }
    for (const raw of whole) {
      const line = stripAnsi(raw).replace(/\s+$/, '');
      if (line === '' || !errorLineOf(line)) continue;
      const key = normalizeErrorKey(line);
      if (s.entries.some((e) => e.key === key)) continue;
      const bytes = Buffer.byteLength(line, 'utf8');
      s.entries.push({ line, key, at: this.now(), bytes });
      s.bytes += bytes;
      while (s.entries.length > this.maxLines || (s.bytes > this.maxBytes && s.entries.length > 1)) {
        const old = s.entries.shift();
        if (old === undefined) break;
        s.bytes -= old.bytes;
      }
    }
  }

  lines(sessionId: string): ErrorLine[] {
    const s = this.sessions.get(sessionId);
    if (s === undefined) return [];
    return s.entries.map((e) => ({ line: e.line, at: e.at }));
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
