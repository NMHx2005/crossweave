const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export interface Semver { major: number; minor: number; patch: number }

export function parseSemver(raw: string): Semver | undefined {
  const m = SEMVER_RE.exec(raw);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** `undefined` on either side (unparseable input) is conservatively "not newer" — never prompt an update off a version string we can't actually read. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const c = parseSemver(candidate);
  const cur = parseSemver(current);
  if (c === undefined || cur === undefined) return false;
  if (c.major !== cur.major) return c.major > cur.major;
  if (c.minor !== cur.minor) return c.minor > cur.minor;
  return c.patch > cur.patch;
}
