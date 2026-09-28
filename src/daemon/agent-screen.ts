import { Terminal } from '@xterm/headless';

/**
 * What a session's terminal shows right now, kept by replaying its output into a
 * headless xterm. The status tracker reads it because an agent's output alone cannot
 * say whether it is busy: Claude Code redraws its status line while it waits for you
 * (output, yet idle), and Codex repaints only the cells that changed (so the words
 * "esc to interrupt" are sent once, then only the timer beside them).
 */
export class AgentScreen {
  private readonly term: Terminal;

  constructor(cols = 80, rows = 24) {
    // No scrollback: only the visible screen matters, and the daemon holds many.
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  }

  write(chunk: string): void {
    this.term.write(chunk);
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term.resize(cols, rows);
  }

  /**
   * The rows around the cursor, as plain text. Agents draw inline, not full-screen: their
   * input box holds the cursor and their "working" line sits just above it, wherever on
   * the screen that is. Reading only there also keeps an old answer higher up that
   * happens to quote "esc to interrupt" from counting.
   */
  nearCursor(above = 12, below = 4): string {
    const buffer = this.term.buffer.active;
    const cursor = buffer.baseY + buffer.cursorY;
    const last = buffer.baseY + this.term.rows - 1;
    const out: string[] = [];
    for (let y = Math.max(buffer.baseY, cursor - above); y <= Math.min(last, cursor + below); y++) {
      out.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    return out.join('\n');
  }

  dispose(): void {
    this.term.dispose();
  }
}

/**
 * What agents show while they work, and remove when their turn ends:
 * - Claude Code: its spinner line, a turning star and a verb with an ellipsis
 *   ("✢ Crunching…", older versions add "(4s · esc to interrupt)"); when the turn ends
 *   the line becomes "✻ Churned for 1s · done 1:39 PM" — no ellipsis;
 * - Codex: "Working (5s • esc to interrupt)";
 * - Gemini CLI: "(esc to cancel, 5s)". Only that form: Claude Code's dialogs end in
 *   "Enter to confirm · Esc to cancel", and they are questions, not work.
 */
// Not /i: the spinner's verb is capitalised, and "* note…" is not work.
export const BUSY_ON_SCREEN = /\b[Ee]sc to interrupt\b|\([Ee]sc to cancel, \d|^\s*[·✢✳✶✻✽*] [A-Z][\w'-]*(?: [\w'-]+){0,3}…/m;

/**
 * An agent waiting on an answer before it goes on: Claude Code's permission prompts and
 * dialogs ("Enter to confirm", trusting a folder), Codex's approvals.
 */
export const ASKING_ON_SCREEN = /\bDo you want to (?:proceed|make this edit|create|allow|run)\b|\bEnter to confirm\b|\btrust (?:this|the files in this) folder\b|\bWould you like to (?:run|make|apply)\b|\bAllow (?:command|this)\b/i;
