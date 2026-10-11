import type { Content } from './content/types'
import type { Lang, Urls } from './site'

declare const htmlBrand: unique symbol
/** A string that is already HTML. Only renderers and page functions make one, and nothing escapes it again. */
export type Html = string & { readonly [htmlBrand]: true }
export const html = (s: string): Html => s as Html

export interface Release {
  tag: string
  publishedAt: string
  assets: string[]
}

export interface PageCtx {
  lang: Lang
  content: Content
  urls: Urls
  release: Release
  notarized: boolean
}

export interface BuildOptions {
  out: string
  env: Record<string, string | undefined>
  repoRoot: string
  refreshRelease: boolean
  fetcher?: typeof fetch
  timeoutMs?: number
  notarized?: boolean
}
