/**
 * What a terminal's saved output looks like when it is written and when it is replayed.
 *
 * A snapshot is the raw VT tail of a terminal: it may be cut in the middle of a line, of an escape
 * sequence, of a surrogate pair, and it may have ended with the alternate screen or mouse reporting
 * on. Replaying it as it stands could print half an escape as text or leave the new pane in a mode
 * its new shell knows nothing about, so it is made safe on both sides.
 */

/** The same budget as a live replay: enough to redraw a screen or two. */
export const SNAPSHOT_LIMIT = 64 * 1024;

/** An escape sequence that has begun but has not ended (no final byte, no terminator). */
const INCOMPLETE_ESCAPE_AT_END = /\x1b(?:\[[0-9;:?<>=! "$'*+,\-./]*|\][^\x07\x1b]*|P[^\x1b]*|[()][^\x1b]?)?$/;

/** A snapshot made safe to store: at most the limit, from a line boundary, without a dangling escape. */
export function prepareSnapshot(scrollback: string): string {
  let text = scrollback;
  if (text.length > SNAPSHOT_LIMIT) {
    text = text.slice(-SNAPSHOT_LIMIT);
    // Half a surrogate pair is not a character.
    const first = text.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) text = text.slice(1);
    // Start on a whole line: the cut may have landed inside a colour sequence or a word.
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1);
  }
  return text.replace(INCOMPLETE_ESCAPE_AT_END, '');
}

/**
 * Reset first, so nothing from before the replay leaks into it; then the snapshot; then leave
 * whatever mode it ended in (alternate screen, mouse reporting, bracketed paste) and show the
 * cursor; then say plainly that the shell is a new one.
 */
export function restoreScrollback(snapshot: string | null, note: string): string {
  const leaveModes = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m';
  const body = snapshot === null || snapshot === '' ? '' : `${snapshot}${leaveModes}\r\n`;
  return `\x1bc\x1b[0m${body}\x1b[2m${note}\x1b[0m\r\n`;
}
