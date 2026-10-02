/**
 * A heuristic secret scrubber for the debug bundle (`cw debug`, the Debug tab, the
 * failing-tail dialog — all text the person may paste to an AI anywhere). It catches
 * the well-known token shapes and key=value pairs whose key names a secret; it is a
 * heuristic, not a guarantee, and every surface that applies it says so. `--raw`
 * (the CLI) is the user's explicit opt-out: it is their own data.
 */

// [A-Za-z0-9_-]{16,} tails so a short coincidental run does not trigger.
const PATTERNS: Array<[RegExp, string]> = [
  // AWS access key ids (20 chars, AKIA + 16).
  [/\b(AKIA[0-9A-Z]{16})\b/g, '[redacted-aws-key]'],
  // GitHub PATs: ghp_, gho_, ghu_, ghs_, ghr_.
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[redacted-github-token]'],
  // OpenAI-style keys and their like.
  [/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[redacted-api-key]'],
  // Bearer headers (JWTs and friends).
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[redacted]'],
  // PEM private key blocks, whole.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]'],
  // user:password@ in URLs.
  [/((?:https?|ftp):\/\/)[^:@\s/]+:[^@\s/]+@/g, '$1[redacted]@'],
];

/** A key whose name says it carries a secret, followed by an assignment — `=`, `:` or
 * whitespace as the separator (shell and JSON both appear in logs). `token` is exact:
 * `tokens = 42` (a count) is not a secret. */
const SECRET_KEY = /((?:api|access|auth|secret|client|refresh)[_-]?(?:key|token|secret)[a-z0-9_-]*|password|passwd|pwd|credential[a-z0-9_-]*|token)([ :=]+)("[^"]*"|'[^']*'|[^\s,;&)}\]]+)/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(SECRET_KEY, (m, key: string, sep: string, value: string) => {
    // Already a token-shaped value the patterns above redacted: leave it alone.
    if (value.startsWith('[redacted')) return m;
    const tail = sep.includes(':') ? ': ' : '=';
    return `${key}${tail}[redacted]`;
  });
  return out;
}
