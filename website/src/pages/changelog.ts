import { lintMarkdown, renderMarkdown } from '../markdown'
import { compareTags } from '../release'
import { shiftHeadings } from '../readme'
import type { Urls } from '../site'
import { html, type BuiltPage, type Release } from '../types'
import { esc } from './common'

export function changelogPage(ctx: { urls: Urls; notes: Array<{ tag: string; markdown: string }>; release: Release }): BuiltPage {
  const { urls, release } = ctx
  const sorted = [...ctx.notes].sort((a, b) => compareTags(b.tag, a.tag))

  const sections = sorted
    .map(({ tag, markdown }) => {
      lintMarkdown(markdown)
      // The release's own heading is the h2, so its notes' headings sit one level lower.
      const rendered = renderMarkdown(shiftHeadings(markdown, 1), { idPrefix: `${tag.replace(/\./g, '-')}-` })
      if (rendered.droppedHtml > 0) throw new Error(`${tag}: raw HTML in the release notes is not supported`)
      const published = tag === release.tag ? release.publishedAt.slice(0, 10) : null
      const unreleased = compareTags(tag, release.tag) > 0
      return `<section class="release" id="${esc(tag.replace(/\./g, '-'))}">
<h2>${esc(tag)}${published === null ? '' : ` <time datetime="${esc(published)}">${esc(published)}</time>`}${unreleased ? ' <span class="badge">Unreleased</span>' : ''}</h2>
${rendered.html}
</section>`
    })
    .join('\n')

  const body = html(`<main id="main" class="page">
<div class="wrap">
<article class="prose">
<h1>Changelog</h1>
<p>What changed in each release. The newest, unreleased entry describes the version being prepared.</p>
${sections}
</article>
</div>
</main>`)

  return {
    path: '/changelog/',
    body,
    meta: {
      lang: 'en',
      path: '/changelog/',
      title: 'Changelog — crossweave',
      description: 'What changed in each crossweave release.',
      canonical: urls.abs('/changelog/'),
      alternates: {},
      ogImage: urls.abs('/img/cockpit-sessions.png'),
    },
  }
}
