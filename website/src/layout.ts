import { escapeHtml, REPO_URL, type Lang, type Urls } from './site'
import type { Content } from './content/types'
import { html, type Html } from './types'

export interface PageMeta {
  lang: Lang
  /** The page's own site path, e.g. `/vi/download/`: it picks the current navigation item. */
  path: string
  title: string
  description: string
  /** Absolute. */
  canonical: string
  /** Site paths (`/vi/download/`) of the same page in each language it exists in; hreflang is written only when both are there. */
  alternates: Partial<Record<Lang, string>>
  /** Absolute, or null for a page with no share image. */
  ogImage: string | null
  noindex?: boolean
}

// GitHub Pages cannot send headers, so the policy is a meta tag; it cannot enforce frame-ancestors (the limitations file says so).
const CSP = "default-src 'none'; img-src 'self' data:; style-src 'self'; base-uri 'none'; form-action 'none'"

const attr = escapeHtml

interface NavItem {
  href: string
  label: string
  match: string
}

function navItems(lang: Lang, content: Content, urls: Urls): NavItem[] {
  const prefix = lang === 'vi' ? '/vi' : ''
  return [
    { href: urls.path(`${prefix}/download/`), label: content.nav.download, match: `${prefix}/download/` },
    { href: urls.path('/docs/'), label: content.nav.docs, match: '/docs/' },
    { href: urls.path('/changelog/'), label: content.nav.changelog, match: '/changelog/' },
  ]
}

export function renderDocument(meta: PageMeta, body: Html, ctx: { content: Content; urls: Urls; version: string }): Html {
  const { content, urls } = ctx
  const other: Lang = meta.lang === 'en' ? 'vi' : 'en'
  const otherPath = meta.alternates[other]
  const bothLanguages = meta.alternates.en !== undefined && meta.alternates.vi !== undefined
  const switchHref = otherPath === undefined ? null : urls.path(otherPath)
  const home = urls.path(meta.lang === 'vi' ? '/vi/' : '/')

  const nav = navItems(meta.lang, content, urls)
    .map((item) => `<a href="${attr(item.href)}"${meta.path.startsWith(item.match) ? ' aria-current="page"' : ''}>${attr(item.label)}</a>`)
    .join('')

  const hreflang = bothLanguages
    ? [
        `<link rel="alternate" hreflang="en" href="${attr(urls.abs(meta.alternates.en ?? '/'))}">`,
        `<link rel="alternate" hreflang="vi" href="${attr(urls.abs(meta.alternates.vi ?? '/vi/'))}">`,
        `<link rel="alternate" hreflang="x-default" href="${attr(urls.abs(meta.alternates.en ?? '/'))}">`,
      ].join('\n')
    : ''

  const og = [
    ['og:type', 'website'],
    ['og:site_name', content.siteName],
    ['og:title', meta.title],
    ['og:description', meta.description],
    ['og:url', meta.canonical],
    ['og:locale', meta.lang === 'vi' ? 'vi_VN' : 'en_US'],
    ...(meta.ogImage === null ? [] : [['og:image', meta.ogImage]]),
  ]
    .map(([property, value]) => `<meta property="${property}" content="${attr(value ?? '')}">`)
    .join('\n')

  const footerLinks = [
    [urls.path(meta.lang === 'vi' ? '/vi/download/' : '/download/'), content.nav.download],
    [urls.path('/changelog/'), content.nav.changelog],
    [urls.path('/docs/'), content.nav.docs],
    [REPO_URL, content.nav.github],
    [`${REPO_URL}/issues`, content.footer.issues],
    [`${REPO_URL}/blob/main/LICENSE`, content.footer.license],
  ]
    .map(([href, label]) => `<a href="${attr(href ?? '')}">${attr(label ?? '')}</a>`)
    .join('')

  return html(`<!doctype html>
<html lang="${attr(content.htmlLang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${attr(CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${attr(meta.title)}</title>
<meta name="description" content="${attr(meta.description)}">
<link rel="canonical" href="${attr(meta.canonical)}">
${hreflang}
${og}
<meta name="twitter:card" content="${meta.ogImage === null ? 'summary' : 'summary_large_image'}">
${meta.noindex === true ? '<meta name="robots" content="noindex">' : ''}
<link rel="icon" href="${attr(urls.path('/icon.png'))}" type="image/png">
<link rel="stylesheet" href="${attr(urls.path('/styles.css'))}">
</head>
<body>
<a class="skip" href="#main">${attr(content.nav.skip)}</a>
<header class="site-header">
<div class="wrap">
<a class="brand" href="${attr(home)}"><img src="${attr(urls.path('/icon.png'))}" alt="" width="28" height="28">${attr(content.siteName)}</a>
<nav class="nav" aria-label="Main">${nav}<a href="${attr(REPO_URL)}">${attr(content.nav.github)}</a>${switchHref === null ? '' : `<a class="lang" href="${attr(switchHref)}" hreflang="${other}" lang="${other}" aria-label="${attr(content.nav.switchLabel)}">${attr(content.nav.switchTo)}</a>`}</nav>
</div>
</header>
${body}
<footer class="site-footer">
<div class="wrap">
<p>${attr(content.footer.tagline)}</p>
<nav aria-label="Footer">${footerLinks}</nav>
<p>${attr(content.footer.version(ctx.version))}${meta.lang === 'en' ? '' : ` · ${attr(content.docsNotice)}`}</p>
</div>
</footer>
</body>
</html>
`)
}
