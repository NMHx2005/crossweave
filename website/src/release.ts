import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { REPO, REPO_URL } from './site'
import type { Release } from './types'

/** Exactly what `.github/workflows/release.yml` publishes (a test reads the workflow to keep it so). */
export const ASSET_ALLOW: readonly string[] = [
  'checksums.txt',
  'install.sh',
  'cockpit-darwin-arm64.dmg',
  'cockpit-darwin-arm64.zip',
  ...['cw', 'cwd'].flatMap((name) => ['darwin-arm64', 'darwin-x64', 'linux-x64'].map((target) => `${name}-${target}`)),
]

/** Flip when a release is notarized: the Download page then swaps its warning for a plain line. The build passes it down. */
export const NOTARIZED = false

export const RELEASES_URL = `${REPO_URL}/releases`
const DOWNLOAD_PREFIX = `${REPO_URL}/releases/download/`
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const PUBLISHED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export function compareTags(a: string, b: string): number {
  const [x, y] = [TAG.exec(a), TAG.exec(b)]
  if (x === null || y === null) throw new Error(`not a release tag: ${x === null ? a : b}`)
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return d
  }
  return 0
}

/** A plain release (a tag like v1.2.3, an ISO date, assets from the allow-list) or null: nothing else is ever trusted. */
export function validateRelease(raw: unknown): Release | null {
  if (raw === null || typeof raw !== 'object') return null
  const { tag, publishedAt, assets } = raw as Record<string, unknown>
  if (typeof tag !== 'string' || !TAG.test(tag)) return null
  if (typeof publishedAt !== 'string' || !PUBLISHED.test(publishedAt)) return null
  if (!Array.isArray(assets) || !assets.every((a) => typeof a === 'string' && ASSET_ALLOW.includes(a))) return null
  return { tag, publishedAt, assets: [...new Set(assets as string[])].sort() }
}

export function readManifest(path: string): Release {
  const release = validateRelease(JSON.parse(readFileSync(path, 'utf8')))
  if (release === null) throw new Error(`${path} is not a valid release manifest`)
  return release
}

/** The direct download for an asset the release really has; null sends the page to the releases page instead. */
export function assetUrl(release: Release, name: string): string | null {
  return release.assets.includes(name) ? `${DOWNLOAD_PREFIX}${release.tag}/${name}` : null
}

const serialise = (release: Release): string => `${JSON.stringify(release, null, 2)}\n`

function fromApi(body: unknown): Release | null {
  if (body === null || typeof body !== 'object') return null
  const { tag_name, published_at, assets } = body as Record<string, unknown>
  if (!Array.isArray(assets)) return null
  const names: unknown[] = []
  for (const asset of assets) {
    if (asset === null || typeof asset !== 'object') return null
    const { name, browser_download_url } = asset as Record<string, unknown>
    if (typeof name !== 'string' || typeof browser_download_url !== 'string') return null
    // A download URL must be this repository's own release asset of the tag the API named.
    if (!browser_download_url.startsWith(`${DOWNLOAD_PREFIX}${String(tag_name)}/`)) return null
    names.push(name)
  }
  return validateRelease({ tag: tag_name, publishedAt: published_at, assets: names })
}

/**
 * Asks GitHub for the latest release and, only if the answer is complete and valid, replaces the manifest (written beside it and renamed,
 * so a crash cannot leave half a file). Never throws: any failure, a stalled connection included, keeps the manifest as it was.
 */
export async function refreshManifest(path: string, opts: { fetcher?: typeof fetch; timeoutMs?: number } = {}): Promise<'updated' | 'unchanged' | 'kept'> {
  const fetcher = opts.fetcher ?? fetch
  const timeoutMs = opts.timeoutMs ?? 5000
  const temp = `${path}.tmp`
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = (async (): Promise<unknown> => {
      const res = await fetcher(API_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'crossweave-website-build' }, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      return await res.json()
    })()
    work.catch(() => undefined) // a late rejection after the deadline must not surface
    // A race, not just an abort signal: a fetcher (or a body stream) that ignores the signal still stops here.
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeoutMs) })
    const release = fromApi(await Promise.race([work, deadline]))
    if (release === null) return 'kept'
    const next = serialise(release)
    let current = ''
    try { current = readFileSync(path, 'utf8') } catch { /* no manifest yet */ }
    if (current === next) return 'unchanged'
    writeFileSync(temp, next)
    renameSync(temp, path)
    return 'updated'
  } catch {
    return 'kept'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try { rmSync(temp, { force: true }) } catch { /* nothing to clean */ }
  }
}
