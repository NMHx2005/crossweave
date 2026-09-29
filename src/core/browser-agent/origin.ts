const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

/**
 * Local means an http(s) page served from this machine's loopback by NAME as the URL parser sees the host:
 * userinfo tricks (`localhost@evil.com`), lookalike suffixes and a trailing dot all fail closed.
 */
export function isLocalOrigin(url: string): boolean {
  const u = parse(url);
  return u !== null && (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname);
}

/** `null` for pages with no origin (about:blank, a bad string): they are never "the same origin" as anything. */
export function originOf(url: string): string | null {
  const u = parse(url);
  return u === null || u.origin === 'null' ? null : u.origin;
}
