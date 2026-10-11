import { compareTags } from '../release'
import { REPO_URL } from '../site'
import { html, type BuiltPage, type PageCtx } from '../types'
import { esc, repoFile } from './common'

export function homePage(ctx: PageCtx): BuiltPage {
  const { content, urls, lang, release } = ctx
  const prefix = lang === 'vi' ? '/vi' : ''
  const path = `${prefix}/`
  const c = content.home
  const shot = ctx.imageSize('cockpit-sessions.png')

  const features = c.features.items
    .map((f) => {
      const isNext = compareTags(f.since, release.tag) > 0
      const links = [f.source, ...(f.source2 === undefined ? [] : [f.source2])]
        .map((source, i) => `<a href="${esc(repoFile(source))}">${esc(i === 0 ? f.linkLabel : `${f.linkLabel} (${i + 1})`)}</a>`)
        .join(' · ')
      return `<article class="card" id="f-${esc(f.id)}">
${isNext ? `<span class="badge">${esc(f.nextBadge(f.since))}</span>\n` : ''}<h3>${esc(f.title)}</h3>
<p>${esc(f.text)}</p>
<p class="card__q">${esc(f.qualifier)}</p>
<p class="card__links">${links}</p>
</article>`
    })
    .join('\n')

  const notList = c.not.items.map((i) => `<li class="card"><h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></li>`).join('\n')

  const rows = c.compare.rows
    .map(([label, hand, us]) => `<tr><th scope="row">${esc(label)}</th><td>${esc(hand)}</td><td>${esc(us)}</td></tr>`)
    .join('\n')

  const faq = c.faq.items.map((i) => `<details><summary>${esc(i.q)}</summary><p>${esc(i.a)}</p></details>`).join('\n')

  const body = html(`<main id="main">
<section class="hero">
<div class="wrap">
<h1>${esc(c.hero.headline)}</h1>
<p class="hero__sub">${esc(c.hero.subtitle)}</p>
<div class="hero__actions">
<a class="btn btn--primary" href="${esc(urls.path(`${prefix}/download/`))}">${esc(c.hero.downloadCta)}</a>
<a class="btn" href="#install">${esc(c.hero.installCta)}</a>
<a class="btn" href="${esc(REPO_URL)}">${esc(c.hero.githubCta)}</a>
</div>
<div class="hero__install" id="install"><code class="cmd">${esc(content.download.cli.installLine)}</code></div>
<p class="hero__meta">${esc(c.hero.versionLine(release.tag))}<br>${esc(c.hero.installNote)}</p>
<img class="hero__shot" src="${esc(urls.path('/img/cockpit-sessions.png'))}" alt="${esc(c.hero.shotAlt)}" width="${shot.width}" height="${shot.height}">
</div>
</section>
<section class="section" id="features">
<div class="wrap">
<h2 class="section__title">${esc(c.features.title)}</h2>
<p class="section__intro">${esc(c.features.intro)}</p>
<div class="grid">
${features}
</div>
</div>
</section>
<section class="section" id="agents">
<div class="wrap">
<h2 class="section__title">${esc(c.agents.title)}</h2>
<p class="section__intro">${esc(c.agents.text)}</p>
<ul class="chips">${c.agents.names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
<p class="agents-note">${esc(c.agents.note)}</p>
</div>
</section>
<section class="section" id="not">
<div class="wrap">
<h2 class="section__title">${esc(c.not.title)}</h2>
<p class="section__intro">${esc(c.not.intro)}</p>
<ul class="not-list">
${notList}
</ul>
</div>
</section>
<section class="section" id="compare">
<div class="wrap">
<h2 class="section__title">${esc(c.compare.title)}</h2>
<div class="table-wrap">
<table class="compare">
<caption>${esc(c.compare.caption)}</caption>
<thead><tr><td></td><th scope="col">${esc(c.compare.headings[1])}</th><th scope="col">${esc(c.compare.headings[2])}</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
<p class="compare__foot">${esc(c.compare.foot)}</p>
</div>
</section>
<section class="section" id="why">
<div class="wrap why">
<h2>${esc(c.why.title)}</h2>
<p>${esc(c.why.text)}</p>
</div>
</section>
<section class="section" id="faq">
<div class="wrap">
<h2 class="section__title">${esc(c.faq.title)}</h2>
<div class="faq">
${faq}
</div>
</div>
</section>
<section class="cta">
<div class="wrap">
<h2>${esc(c.cta.title)}</h2>
<p>${esc(c.cta.text)}</p>
<div class="hero__actions">
<a class="btn btn--primary" href="${esc(urls.path('/docs/quickstart/'))}">${esc(content.nav.docs)}</a>
<a class="btn" href="${esc(urls.path('/changelog/'))}">${esc(content.nav.changelog)}</a>
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
      ogImage: urls.abs('/img/cockpit-sessions.png'),
    },
  }
}
