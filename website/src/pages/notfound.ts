import type { Content } from '../content/types'
import type { Urls } from '../site'
import { html, type BuiltPage } from '../types'
import { esc } from './common'

/** One 404.html for the whole site: GitHub Pages serves it for every missing path, whatever the language of the visitor. */
export function notFoundPage(ctx: { urls: Urls; en: Content; vi: Content }): BuiltPage {
  const { urls, en, vi } = ctx
  const body = html(`<main id="main" class="page">
<div class="wrap">
<h1>${esc(en.notFound.title)} · ${esc(vi.notFound.title)}</h1>
<div class="stack">
<p>${esc(en.notFound.text)} <a href="${esc(urls.path('/'))}">${esc(en.notFound.home)}</a></p>
<p lang="vi">${esc(vi.notFound.text)} <a href="${esc(urls.path('/vi/'))}">${esc(vi.notFound.home)}</a></p>
</div>
</div>
</main>`)
  return {
    path: '/404.html',
    body,
    meta: {
      lang: 'en',
      path: '/404.html',
      title: `${en.notFound.title} — crossweave`,
      description: en.notFound.text,
      canonical: urls.abs('/404.html'),
      alternates: {},
      ogImage: null,
      noindex: true,
    },
  }
}
