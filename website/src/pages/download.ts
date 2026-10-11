import { ASSET_ALLOW, RELEASES_URL, assetUrl } from '../release'
import { html, type BuiltPage, type PageCtx } from '../types'
import { esc } from './common'

const QUARANTINE_COMMAND = 'xattr -dr com.apple.quarantine "/Applications/crossweave Cockpit.app"'

const PLATFORMS: Array<[string, string]> = [
  ['darwin-arm64', 'macOS · Apple Silicon'],
  ['darwin-x64', 'macOS · Intel'],
  ['linux-x64', 'Linux · x64'],
]

export function downloadPage(ctx: PageCtx): BuiltPage {
  const { content, urls, lang, release } = ctx
  const c = content.download
  const prefix = lang === 'vi' ? '/vi' : ''
  const path = `${prefix}/download/`

  // An asset the release does not carry is linked to the releases page, never to a URL that would 404.
  const link = (name: string, label: string, cls = 'btn'): string => `<a class="${cls}" href="${esc(assetUrl(release, name) ?? RELEASES_URL)}">${esc(label)}</a>`

  const notice = ctx.notarized
    ? `<div class="note"><h2>${esc(c.notarized.title)}</h2><p>${esc(c.notarized.text)}</p></div>`
    : `<div class="note">
<h2>${esc(c.notNotarized.title)}</h2>
<p>${esc(c.notNotarized.text)}</p>
<p>${esc(c.notNotarized.commandNote)}</p>
<code class="cmd">${esc(QUARANTINE_COMMAND)}</code>
<p>${esc(c.notNotarized.installerNote)}</p>
</div>`

  const files = PLATFORMS.map(([target, label]) => {
    const cw = assetUrl(release, `cw-${target}`)
    const cwd = assetUrl(release, `cwd-${target}`)
    const links = [cw === null ? null : `<a href="${esc(cw)}">cw-${esc(target)}</a>`, cwd === null ? null : `<a href="${esc(cwd)}">cwd-${esc(target)}</a>`].filter((l) => l !== null)
    return `<li>${esc(label)}: ${links.length === 0 ? `<a href="${esc(RELEASES_URL)}">${esc(c.older)}</a>` : links.join(' · ')}</li>`
  }).join('\n')

  const extras = ['checksums.txt', 'install.sh']
    .filter((name) => ASSET_ALLOW.includes(name))
    .map((name) => `<a href="${esc(assetUrl(release, name) ?? RELEASES_URL)}">${esc(name)}</a>`)
    .join(' · ')

  const body = html(`<main id="main" class="page">
<div class="wrap">
<h1>${esc(c.headline)}</h1>
<div class="stack">
<p>${esc(c.intro)} <strong>${esc(release.tag)}</strong></p>
<section>
<h2>${esc(c.cockpit.title)}</h2>
<p>${esc(c.cockpit.text)}</p>
<div class="actions">${link('cockpit-darwin-arm64.dmg', c.cockpit.dmg, 'btn btn--primary')}${link('cockpit-darwin-arm64.zip', c.cockpit.zip)}</div>
</section>
${notice}
<section>
<h2>${esc(c.cli.title)}</h2>
<p>${esc(c.cli.text)}</p>
<code class="cmd">${esc(c.cli.installLine)}</code>
<p>${esc(c.cli.requires)}</p>
<p>${esc(c.cli.manual)}</p>
<ul>
${files}
</ul>
<p>${extras} · <a href="${esc(RELEASES_URL)}">${esc(c.older)}</a></p>
</section>
</div>
</div>
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
      alternates: { en: '/download/', vi: '/vi/download/' },
      ogImage: urls.abs('/img/cockpit-sessions.png'),
    },
  }
}
