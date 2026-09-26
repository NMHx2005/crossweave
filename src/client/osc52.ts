/** Larger than any selection a person copies; a cap on what an agent can push. */
const MAX_BASE64 = 1024 * 1024;

/**
 * The text an OSC 52 sequence (`ESC ] 52 ; <selection> ; <base64> BEL`) asks to put
 * on the clipboard — `data` is what follows `52;` — or undefined when it is not a
 * write the terminal should honour.
 *
 * Claude Code copies its own mouse selection this way (the drag goes to the agent
 * when it tracks the mouse), and a terminal that ignores OSC 52 leaves the
 * clipboard unchanged: every paste returned whatever was copied before. Reads (`?`)
 * are never answered — that would hand the user's clipboard to the agent.
 * Browser-safe: no Buffer.
 */
export function clipboardWriteFromOsc52(data: string): string | undefined {
  const sep = data.indexOf(';');
  if (sep < 0) return undefined;
  const payload = data.slice(sep + 1);
  if (payload === '?' || payload.length > MAX_BASE64) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return undefined;
  try {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
