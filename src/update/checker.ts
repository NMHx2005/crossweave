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
    try {
      const res = await fetchFn(`${API_BASE}/repos/${repo}/releases/latest`);
      if (!res.ok) return undefined; // swallowed — do not touch lastCheckedAt, retry next invocation
      const body = (await res.json()) as { tag_name?: string };
      if (typeof body.tag_name !== 'string') return undefined;
      latest = body.tag_name;
      saveGlobalConfig({ ...cfg, lastCheckedAt: new Date(now).toISOString(), lastKnownLatest: latest }, deps.homeDir);
    } catch {
      return undefined; // network failure — swallowed, retried next invocation
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
