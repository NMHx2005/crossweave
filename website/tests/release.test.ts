import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSET_ALLOW, assetUrl, compareTags, readManifest, refreshManifest, validateRelease } from '../src/release'

const REAL = new URL('../release.json', import.meta.url).pathname
const GOOD = { tag: 'v0.6.0', publishedAt: '2026-10-12T00:00:00Z', assets: ['checksums.txt', 'cockpit-darwin-arm64.dmg', 'cw-darwin-arm64'] }
const BASE = 'https://github.com/NMHx2005/crossweave/releases/download/v0.6.0/'

const api = (over: Record<string, unknown> = {}): unknown => ({
  tag_name: GOOD.tag,
  published_at: GOOD.publishedAt,
  assets: GOOD.assets.map((name) => ({ name, browser_download_url: `${BASE}${name}` })),
  ...over,
})
const respond = (body: unknown, init?: ResponseInit): typeof fetch => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), init)) as unknown as typeof fetch

let dir = ''
let manifest = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-release-'))
  manifest = join(dir, 'release.json')
  writeFileSync(manifest, readFileSync(REAL, 'utf8'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the committed manifest', () => {
  test('is valid, in the exact form the refresh writes, and names only assets the workflow publishes', () => {
    const release = readManifest(REAL)
    expect(release.tag).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(release.assets.every((a) => ASSET_ALLOW.includes(a))).toBe(true)
    expect(readFileSync(REAL, 'utf8')).toBe(`${JSON.stringify(release, null, 2)}\n`)
  })

  test('the allow-list is exactly what release.yml publishes', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64']) expect(workflow).toContain(`target: ${target}`)
    for (const text of ['cw-${{ matrix.target }}', 'cwd-${{ matrix.target }}', 'cockpit-darwin-arm64.zip', 'cockpit-darwin-arm64.dmg', 'checksums.txt', 'install.sh']) {
      expect(workflow, text).toContain(text)
    }
    const expected = ['checksums.txt', 'install.sh', 'cockpit-darwin-arm64.dmg', 'cockpit-darwin-arm64.zip', ...['cw', 'cwd'].flatMap((n) => ['darwin-arm64', 'darwin-x64', 'linux-x64'].map((t) => `${n}-${t}`))]
    expect([...ASSET_ALLOW].sort()).toEqual(expected.sort())
  })
})

describe('compareTags and validateRelease', () => {
  test('order is semantic, not alphabetical', () => {
    expect(compareTags('v0.10.0', 'v0.9.0')).toBeGreaterThan(0)
    expect(compareTags('v1.0.0', 'v1.0.0')).toBe(0)
    expect(compareTags('v0.2.1', 'v0.10.0')).toBeLessThan(0)
  })

  test('rejects anything that is not a plain release', () => {
    for (const bad of [
      { ...GOOD, tag: 'v1.0.0<img>' },
      { ...GOOD, tag: 'latest' },
      { ...GOOD, tag: 'v1.0.0-rc.1' },
      { ...GOOD, publishedAt: 'yesterday' },
      { ...GOOD, assets: ['evil.sh'] },
      { ...GOOD, assets: 'checksums.txt' },
      { tag: GOOD.tag },
      null,
      'text',
      7,
    ]) {
      expect(validateRelease(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(validateRelease(GOOD)).toEqual(GOOD)
  })
})

describe('assetUrl', () => {
  test('is the GitHub release URL for an asset the release has, and null for one it does not', () => {
    expect(assetUrl(GOOD, 'cw-darwin-arm64')).toBe(`${BASE}cw-darwin-arm64`)
    expect(assetUrl(GOOD, 'cockpit-darwin-arm64.zip')).toBeNull()
  })
})

describe('refreshManifest keeps the manifest unless a complete, valid release arrives', () => {
  const before = (): string => readFileSync(manifest, 'utf8')

  test('a good release rewrites the file; the same release again changes nothing', async () => {
    expect(await refreshManifest(manifest, { fetcher: respond(api()) })).toBe('updated')
    expect(readManifest(manifest)).toEqual({ ...GOOD, assets: [...GOOD.assets].sort() })
    expect(readFileSync(manifest, 'utf8').endsWith('\n')).toBe(true)
    expect(await refreshManifest(manifest, { fetcher: respond(api()) })).toBe('unchanged')
    expect(readdirSync(dir)).toEqual(['release.json'])
  })

  const failures: Array<[string, typeof fetch]> = [
    ['a rejecting fetch', (async () => { throw new Error('offline') }) as unknown as typeof fetch],
    ['a fetch that never answers and ignores its abort signal', (() => new Promise(() => undefined)) as unknown as typeof fetch],
    ['a body that never ends', (async () => new Response(new ReadableStream({ start() {} }))) as unknown as typeof fetch],
    ['a server error', respond('{}', { status: 500 })],
    ['a body that is not JSON', respond('<html>')],
    ['a tag that is not a release', respond(api({ tag_name: 'nightly' }))],
    ['an asset the site does not know', respond(api({ assets: [{ name: 'evil.sh', browser_download_url: `${BASE}evil.sh` }] }))],
    ['a download URL from another host', respond(api({ assets: [{ name: 'checksums.txt', browser_download_url: 'https://evil.example/checksums.txt' }] }))],
    ['a download URL from another repository', respond(api({ assets: [{ name: 'checksums.txt', browser_download_url: 'https://github.com/other/repo/releases/download/v0.6.0/checksums.txt' }] }))],
  ]
  test.each(failures)('%s leaves the manifest byte-identical', async (_name, fetcher) => {
    const original = before()
    expect(await refreshManifest(manifest, { fetcher, timeoutMs: 50 })).toBe('kept')
    expect(before()).toBe(original)
    expect(readdirSync(dir)).toEqual(['release.json'])
  })

  test('a failed write leaves the original and no temp file behind', async () => {
    const blocked = join(dir, 'nope', 'release.json')
    expect(await refreshManifest(blocked, { fetcher: respond(api()) })).toBe('kept')
    expect(existsSync(blocked)).toBe(false)
    expect(before()).toBe(readFileSync(REAL, 'utf8'))
  })
})
