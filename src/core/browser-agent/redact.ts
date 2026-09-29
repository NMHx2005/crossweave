const NAME = String.raw`[\w.-]*(?:token|key|secret|passw|auth|session)[\w.-]*`;
// name, optional closing quote, separator, then a quoted value or a bare one up to a delimiter.
const PAIR = new RegExp(String.raw`(["']?)(${NAME})\1(\s*[=:]\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s&;,"'}\]]+)`, 'gi');

/**
 * Best effort, on text and URLs that leave the cockpit: a pair whose NAME looks secret loses its value.
 * It cannot see a secret inside prose, and it is not applied to `dom`, `eval` or screenshots — those are the page.
 */
export function redact(text: string): string {
  return text.replace(PAIR, (_all, quote: string, name: string, sep: string, value: string) => {
    const q = value.startsWith('"') || value.startsWith("'") ? value.charAt(0) : '';
    return `${quote}${name}${quote}${sep}${q}[redacted]${q}`;
  });
}
