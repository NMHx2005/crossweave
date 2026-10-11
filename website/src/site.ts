export type Lang = 'en' | 'vi'

export const REPO = 'NMHx2005/crossweave'
export const REPO_URL = `https://github.com/${REPO}`

export interface SiteConfig {
  readonly origin: string
  readonly base: string
  readonly domain: string | null
}

const DEFAULT_ORIGIN = 'https://nmhx2005.github.io'
const DEFAULT_BASE = '/crossweave'

function normaliseBase(raw: string): string {
  const trimmed = raw.split('/').filter((part) => part !== '').join('/')
  return trimmed === '' ? '' : `/${trimmed}`
}

/** A custom domain serves the site from its root, so it overrides both the origin and the base. */
export function loadConfig(env: Record<string, string | undefined>): SiteConfig {
  const domain = env['SITE_DOMAIN']
  if (domain !== undefined && domain !== '') return { origin: `https://${domain}`, base: '', domain }
  const origin = (env['SITE_URL'] ?? DEFAULT_ORIGIN).replace(/\/+$/, '')
  const base = env['SITE_BASE'] === undefined ? DEFAULT_BASE : normaliseBase(env['SITE_BASE'])
  return { origin, base, domain: null }
}

export interface Urls {
  /** `/docs/` becomes `/crossweave/docs/`: for href and src. */
  path(p: string): string
  /** The absolute URL, for canonical, Open Graph, hreflang and the sitemap. */
  abs(p: string): string
}

export function makeUrls(config: SiteConfig): Urls {
  const path = (p: string): string => {
    if (!p.startsWith('/')) throw new Error(`a site path starts with a slash: ${JSON.stringify(p)}`)
    return `${config.base}${p}`
  }
  return { path, abs: (p) => `${config.origin}${path(p)}` }
}

/** Escapes text for HTML text and quoted attributes. Applied once, at the leaf: it is not idempotent on purpose. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
