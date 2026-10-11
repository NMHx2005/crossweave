import { diagramSvg } from '../diagram'
import { compareTags } from '../release'
import { inDevelopment, recentReleases } from '../releases'
import { REPO_URL } from '../site'
import type { Feature } from '../content/types'
import { html, type BuiltPage, type PageCtx } from '../types'
import { clip, esc, formatDay, releaseAnchor, repoFile } from './common'

/** The pictures of the three steps: stills from the demo clip once it is made (website/public/img). */
const STEP_IMAGES = ['step-1.png', 'step-2.png', 'step-3.png'] as const

/** The demo clip and its first frame, recorded by apps/cockpit/scripts/site-video.ts (website/public/media). */
const HERO_CLIP = { src: '/media/demo.mp4', poster: '/media/poster.jpg', width: 1920, height: 1080 } as const

const GROUPS = ['run', 'watch', 'land', 'review'] as const

export function homePage(ctx: PageCtx): BuiltPage {
  const { content, urls, lang, release } = ctx
  const prefix = lang === 'vi' ? '/vi' : ''
  const path = `${prefix}/`
  const c = content.home
  const changelog = (tag: string): string => urls.path(`/changelog/#${releaseAnchor(tag)}`)

  const released = c.features.items.filter((f) => compareTags(f.since, release.tag) <= 0)
  const coming = c.features.items.filter((f) => compareTags(f.since, release.tag) > 0)
  const comingTag = coming.map((f) => f.since).sort(compareTags)[0]

  // Each word in its own mask so it can slide up from below it; the spaces between stay text, so the heading still reads as one sentence.
  const headline = c.hero.headline
    .split(' ')
    .map((word) => `<span class="word-mask"><span class="word">${esc(word)}</span></span>`)
    .join(' ')

  // One sentence per card; the longer words, the limits and the link to the full limitations wait behind a disclosure.
  const card = (f: Feature, level: 3 | 4): string => {
    const links = [f.source, ...(f.source2 === undefined ? [] : [f.source2])]
      .map((source, i) => `<a href="${esc(repoFile(source))}">${esc(i === 0 ? c.groups.fullLimits : `${c.groups.fullLimits} (${i + 1})`)}</a>`)
      .join(' · ')
    return `<article class="card" data-reveal id="f-${esc(f.id)}">
<h${level}>${esc(f.title)}</h${level}>
<p>${esc(f.summary)}</p>
<details class="limits"><summary>${esc(c.groups.limits)}<span class="sr-only"> · ${esc(f.title)}</span></summary>
<p>${esc(f.text)}</p>
<p class="card__q">${esc(f.qualifier)}</p>
<p class="card__links">${links}</p>
</details>
</article>`
  }

  const groups = GROUPS.map((group) => {
    const items = released.filter((f) => f.group === group)
    if (items.length === 0) return ''
    return `<div class="group" id="group-${group}">
<h3 data-reveal>${esc(c.groups.names[group])}</h3>
<div class="grid">
${items.map((f) => card(f, 4)).join('\n')}
</div>
</div>`
  }).join('\n')

  const comingSection =
    coming.length === 0 || comingTag === undefined
      ? ''
      : `<section class="section" id="coming">
<div class="wrap">
<h2 class="section__title" data-reveal>${esc(c.groups.coming(comingTag))}</h2>
<p class="section__intro" data-reveal>${esc(c.groups.comingIntro)}</p>
<div class="grid">
${coming.map((f) => card(f, 3)).join('\n')}
</div>
</div>
</section>`

  const pill =
    comingTag === undefined
      ? ''
      : `<p class="hero__pill"><a class="pill" id="pill" href="${esc(changelog(comingTag))}">${esc(c.pill(comingTag, coming.map((f) => f.label)))}</a></p>\n`

  const day = release.dates?.[release.tag] ?? release.publishedAt.slice(0, 10)

  const steps = c.how.steps
    .map((step, i) => {
      const name = STEP_IMAGES[i] ?? STEP_IMAGES[0]
      const size = ctx.imageSize(name)
      return `<li class="step" data-reveal>
<span class="step__n" aria-hidden="true">${i + 1}</span>
<h3>${esc(step.title)}</h3>
<code class="step__cmd">${esc(step.command)}</code>
<p>${esc(step.text)}</p>
<img src="${esc(urls.path(`/img/${name}`))}" alt="${esc(step.imageAlt)}" width="${size.width}" height="${size.height}" loading="lazy">
</li>`
    })
    .join('\n')

  const column = (title: string, items: string[], cls: string): string =>
    `<div class="fit__col fit__col--${cls}" data-reveal><h3>${esc(title)}</h3><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`

  const rows = c.compare.rows
    .map(([label, hand, us]) => `<tr><th scope="row">${esc(label)}</th><td>${esc(hand)}</td><td>${esc(us)}</td></tr>`)
    .join('\n')

  const recent = recentReleases(ctx.notes, release, 3)
  const developing = inDevelopment(ctx.notes, release)
  const releaseItems = [
    ...(developing === null ? [] : [`<li class="releases__dev" data-reveal><a href="${esc(changelog(developing))}">${esc(c.releases.developing(developing))}</a></li>`]),
    ...recent.map(
      (r) =>
        `<li data-reveal><a href="${esc(changelog(r.tag))}"><strong>${esc(r.tag)}</strong>${r.date === null ? '' : ` <time datetime="${esc(r.date)}">${esc(formatDay(r.date, lang))}</time>`}</a><p>${esc(clip(r.headline, 170))}</p></li>`,
    ),
  ].join('\n')

  const faq = c.faq.items.map((i) => `<details data-reveal><summary>${esc(i.q)}</summary><p>${esc(i.a)}</p></details>`).join('\n')

  const installLine = content.download.cli.installLine
  const body = html(`<main id="main">
<section class="hero" id="hero">
<div class="wrap">
${pill}<h1>${headline}</h1>
<p class="hero__sub">${esc(c.hero.subtitle)}</p>
<div class="hero__install" id="install">
<p class="install__label">${esc(c.hero.installLabel)}</p>
<div class="install"><code class="cmd">${esc(installLine)}</code><button type="button" class="copy" data-copy="${esc(installLine)}" data-copied="${esc(c.hero.copiedLabel)}" data-failed="${esc(c.hero.copyFailedLabel)}" hidden>${esc(c.hero.copyLabel)}</button></div>
<span class="sr-only" role="status" aria-live="polite"></span>
</div>
<div class="hero__actions">
<a class="btn btn--primary" href="${esc(urls.path(`${prefix}/download/`))}">${esc(c.hero.appCta)}</a>
<a class="btn" href="${esc(REPO_URL)}">${esc(c.hero.githubCta)}</a>
</div>
<p class="hero__meta">${esc(c.hero.metaRelease(release.tag, formatDay(day, lang)))}<a href="${esc(changelog(release.tag))}">${esc(c.hero.whatsNew)} →</a><br>${esc(c.hero.installNote)}</p>
<div class="hero__media">
<video controls muted loop playsinline preload="metadata" data-motion poster="${esc(urls.path(HERO_CLIP.poster))}" width="${HERO_CLIP.width}" height="${HERO_CLIP.height}" aria-label="${esc(c.hero.videoAlt)}"><source src="${esc(urls.path(HERO_CLIP.src))}" type="video/mp4"></video><button type="button" class="video__toggle" data-play="${esc(c.hero.videoPlayLabel)}" data-pause="${esc(c.hero.videoPauseLabel)}" hidden>${esc(c.hero.videoPauseLabel)}</button>
</div>
<p class="hero__note">${esc(c.hero.videoNote)}</p>
<details class="transcript"><summary>${esc(c.hero.videoTranscript.title)}</summary>
<ol>
${c.hero.videoTranscript.steps.map((s) => `<li>${esc(s)}</li>`).join('\n')}
</ol>
</details>
</div>
</section>
<section class="section" id="how">
<div class="wrap">
<h2 class="section__title" data-reveal>${esc(c.how.title)}</h2>
<p class="section__intro" data-reveal>${esc(c.how.intro)}</p>
<div class="diagram-wrap" data-reveal>${diagramSvg(c.how.diagramAlt)}</div>
<ol class="steps">
${steps}
</ol>
</div>
</section>
<section class="section" id="features">
<div class="wrap">
<h2 class="section__title" data-reveal>${esc(c.groups.title)}</h2>
<p class="section__intro" data-reveal>${esc(c.groups.intro)}</p>
${groups}
</div>
</section>
${comingSection}
<section class="section" id="fit">
<div class="wrap">
<h2 class="section__title" data-reveal>${esc(c.fit.title)}</h2>
<div class="fit">
${column(c.fit.forTitle, c.fit.forItems, 'for')}
${column(c.fit.notTitle, c.fit.notItems, 'not')}
</div>
</div>
</section>
<section class="section" id="agents">
<div class="wrap">
<h2 class="section__title" data-reveal>${esc(c.agents.title)}</h2>
<p class="section__intro" data-reveal>${esc(c.agents.text)}</p>
<ul class="chips" data-reveal="group">${c.agents.names.map((n) => `<li class="reveal-item">${esc(n)}</li>`).join('')}</ul>
<p class="agents-note" data-reveal>${esc(c.agents.note)}</p>
</div>
</section>
<section class="section" id="compare">
<div class="wrap">
<h2 class="section__title" data-reveal>${esc(c.compare.title)}</h2>
<div class="table-wrap" data-reveal>
<table class="compare">
<caption>${esc(c.compare.caption)}</caption>
<thead><tr><td></td><th scope="col">${esc(c.compare.headings[1])}</th><th scope="col">${esc(c.compare.headings[2])}</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
<p class="compare__foot" data-reveal>${esc(c.compare.foot)}</p>
</div>
</section>
<section class="section" id="releases">
<div class="wrap">
<h2 class="section__title" data-reveal>${esc(c.releases.title)}</h2>
<ul class="releases">
${releaseItems}
</ul>
<p class="releases__all" data-reveal><a href="${esc(urls.path('/changelog/'))}">${esc(c.releases.all)} →</a></p>
</div>
</section>
<section class="section" id="faq">
<div class="wrap">
<h2 class="section__title" data-reveal>${esc(c.faq.title)}</h2>
<div class="faq">
${faq}
</div>
</div>
</section>
<section class="cta" id="cta">
<div class="wrap" data-reveal>
<h2>${esc(c.cta.title)}</h2>
<p>${esc(c.cta.text)}</p>
<div class="hero__actions">
<a class="btn btn--primary" href="${esc(urls.path('/docs/quickstart/'))}">${esc(c.cta.button)}</a>
<a class="btn" href="${esc(urls.path(`${prefix}/download/`))}">${esc(content.nav.download)}</a>
</div>
</div>
</section>
</main>`)

  return {
    path,
    body,
    meta: {
      lang,
      path,
      title: c.title,
      description: c.description,
      canonical: urls.abs(path),
      alternates: { en: '/', vi: '/vi/' },
      ogImage: urls.abs('/img/og.png'),
      ogImageInfo: { width: 1200, height: 630, alt: `crossweave: ${c.hero.headline}` },
      // What a search engine may say about the product: only what is true and checkable. No rating, no review count.
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: content.siteName,
        description: c.description,
        url: urls.abs(path),
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux',
        softwareVersion: release.tag,
        license: 'https://opensource.org/license/mit',
        downloadUrl: urls.abs('/download/'),
        sameAs: REPO_URL,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    },
  }
}
