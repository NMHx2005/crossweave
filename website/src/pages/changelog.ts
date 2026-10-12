import { lintMarkdown, renderMarkdown } from '../markdown'
import { compareTags } from '../release'
import { shiftHeadings } from '../readme'
import type { Content } from '../content/types'
import type { Lang, Urls } from '../site'
import { html, type BuiltPage, type Release } from '../types'
import { esc } from './common'

export function changelogPage(ctx: { urls: Urls; notes: Array<{ tag: string; markdown: string }>; release: Release; lang?: Lang; content?: Content }): BuiltPage {
  const { urls, release } = ctx
  const lang = ctx.lang ?? 'en'
  const copy = ctx.content?.changelog ?? (lang === 'vi'
    ? { title: 'Lịch sử thay đổi — crossweave', description: 'Những thay đổi trong từng bản phát hành crossweave.', introduction: 'Những thay đổi trong từng bản phát hành. Mục mới nhất chưa phát hành mô tả phiên bản đang được chuẩn bị.', unreleased: 'Chưa phát hành', releaseIndex: 'Điều hướng bản phát hành' }
    : { title: 'Changelog — crossweave', description: 'What changed in each crossweave release.', introduction: 'What changed in each release. The newest, unreleased entry describes the version being prepared.', unreleased: 'Unreleased', releaseIndex: 'Release navigation' })
  const prefix = lang === 'vi' ? '/vi' : ''
  const sorted = [...ctx.notes].sort((a, b) => compareTags(b.tag, a.tag))

  const sections = sorted
    .map(({ tag, markdown }) => {
      lintMarkdown(markdown)
      // The release's own heading is the h2, so its notes' headings sit one level lower.
      const shifted = shiftHeadings(markdown, 1)
      const prefix = `${tag.replace(/\./g, '-')}-`
      // Ids are prefixed so several releases can share a page, which also moves the target of a link inside a note: `#upgrading` must
      // become `#v0-9-0-upgrading`, and a link to nothing is an error rather than a dead anchor.
      const known = new Set(renderMarkdown(shifted, { idPrefix: prefix }).headings.map((h) => h.id))
      const rendered = renderMarkdown(shifted, {
        idPrefix: prefix,
        rewriteLink(href) {
          if (!href.startsWith('#')) return href
          const id = `${prefix}${href.slice(1)}`
          if (!known.has(id)) throw new Error(`${tag}: the link ${href} points at nothing`)
          return `#${id}`
        },
      })
      if (rendered.droppedHtml > 0) throw new Error(`${tag}: raw HTML in the release notes is not supported`)
      const unreleased = compareTags(tag, release.tag) > 0
      // A published release shows its day; one the manifest has no day for shows none rather than a guess; an unpublished one never shows a day.
      const published = unreleased ? null : (release.dates?.[tag] ?? (tag === release.tag ? release.publishedAt.slice(0, 10) : null))
      return `<section class="release" id="${esc(tag.replace(/\./g, '-'))}">
<h2>${esc(tag)}${published === null ? '' : ` <time datetime="${esc(published)}">${esc(published)}</time>`}${unreleased ? ` <span class="badge">${esc(copy.unreleased)}</span>` : ''}</h2>
${rendered.html}
</section>`
    })
    .join('\n')
  const index = `<nav class="changelog__index" aria-label="${esc(copy.releaseIndex)}"><p class="changelog__index-title">${esc(copy.releaseIndex)}</p><ul>${sorted.map(({ tag }) => `<li><a href="#${esc(tag.replace(/\./g, '-'))}">${esc(tag)}</a></li>`).join('')}</ul></nav>`

  const body = html(`<main id="main" class="page">
<div class="wrap">
<header class="changelog__header">
<h1>${esc(lang === 'vi' ? 'Lịch sử thay đổi' : 'Changelog')}</h1>
<p>${esc(copy.introduction)}</p>
</header>
<div class="changelog-layout">
${index}
<article class="prose">
${sections}
</article>
</div>
</div>
</main>`)

  return {
    path: `${prefix}/changelog/`,
    body,
    meta: {
      lang,
      path: `${prefix}/changelog/`,
      title: copy.title,
      description: copy.description,
      canonical: urls.abs(`${prefix}/changelog/`),
      alternates: { en: '/changelog/', vi: '/vi/changelog/' },
      ogImage: urls.abs('/img/cockpit-sessions.png'),
    },
  }
}
