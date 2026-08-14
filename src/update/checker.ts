import { loadGlobalConfig, saveGlobalConfig } from './global-config.js';
import { isNewerVersion } from './semver.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REPO = 'NMHx2005/crossweave';
/** Test/CI seam — overrides the GitHub API host itself, not just the repo path. Read once here so every caller (this module, and Task 7's `cw update`) shares one override mechanism instead of each inventing its own. */
const API_BASE = process.env.CW_UPDATE_API_BASE ?? 'https://api.github.com';

export interface UpdateCheckDeps {
  homeDir?: string;
  clock?: () => number;
  fetchFn?: typeof fetch;
  repo?: string;
}

/** Asks GitHub what the latest release tag is. Never throws — returns undefined on any failure
 * (non-2xx, malformed body, network error, or timeout). Shared by `checkForUpdate` and `cw update`
 * (Task 7), which is why the fetch itself lives here rather than duplicated in each caller. */
export async function resolveLatestTag(repo: string = DEFAULT_REPO, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetchFn(`${API_BASE}/repos/${repo}/releases/latest`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { tag_name?: string };
    return typeof body.tag_name === 'string' ? body.tag_name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Called on every `cw` invocation (wired in Task 4) — never throws, never
 * blocks longer than a network failure needs to surface, never prints
 * anything itself (the caller decides how/when). Observability, not a
 * safety mechanism: any failure here is swallowed and simply means no
 * notice this time (spec §6).
 */
export async function checkForUpdate(currentVersion: string, deps: UpdateCheckDeps = {}): Promise<string | undefined> {
  const clock = deps.clock ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const repo = deps.repo ?? DEFAULT_REPO;
  const cfg = loadGlobalConfig(deps.homeDir);

  if (!cfg.updateCheck) return undefined;

  const now = clock();
  const cacheIsFresh = cfg.lastCheckedAt !== null && now - Date.parse(cfg.lastCheckedAt) < DAY_MS;

  let latest = cfg.lastKnownLatest;
  if (!cacheIsFresh) {
    const resolved = await resolveLatestTag(repo, fetchFn);
    if (resolved === undefined) return undefined; // swallowed — do not touch lastCheckedAt, retry next invocation
    latest = resolved;
    try {
      saveGlobalConfig({ ...cfg, lastCheckedAt: new Date(now).toISOString(), lastKnownLatest: latest }, deps.homeDir);
    } catch {
      return undefined; // cache-write failure — swallowed, same posture as the fetch/parse failures above
    }
  }

  if (latest === null || !isNewerVersion(latest, currentVersion)) return undefined;
  if (cfg.lastNotifiedVersion === latest) return undefined;

  try {
    saveGlobalConfig({ ...loadGlobalConfig(deps.homeDir), lastKnownLatest: latest, lastNotifiedVersion: latest }, deps.homeDir);
  } catch {
    return undefined; // dedup-write failure — swallowed, same posture as the fetch/parse failures above
  }
  return `crossweave: ${latest} is available (you have v${currentVersion.replace(/^v/, '')}) — run 'cw update' to install it.`;
}
