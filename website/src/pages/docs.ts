import { scanFences } from '../fences'
import { lintMarkdown, renderMarkdown, slugify } from '../markdown'
import { prepareReadmeMarkdown, sectionsOf, shiftHeadings } from '../readme'
import { REPO_URL, escapeHtml, type Urls } from '../site'
import { html, type BuiltPage, type Release } from '../types'
import { repoFile } from './common'

export interface DocsCtx {
  urls: Urls
  readme: string
  concepts: string
  cliHelp: string
  /** The latest published release: these pages follow main, which can be ahead of it. */
  release: Release
  /** The real size of a committed site image, by file name. */
  imageSize(name: string): { width: number; height: number }
}

interface DocPage {
  /** Markdown the site wrote itself, whose root-relative links are already under the base; a README's are repository paths. */
  generated?: boolean
  slug: string
  title: string
  description: string
  markdown: string
}

/** The COMMANDS table of `cw --help`: a name, two or more spaces, a summary. */
export function parseCommands(help: string): Array<{ name: string; summary: string }> {
  const lines = help.split('\n')
  const start = lines.findIndex((l) => l.trim() === 'COMMANDS')
  if (start < 0) return []
  const out: Array<{ name: string; summary: string }> = []
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+(\S+)\s{2,}(.+?)\s*$/.exec(line)
    if (m !== null) out.push({ name: m[1] ?? '', summary: m[2] ?? '' })
    else if (out.length > 0 && line.trim() === '') break
  }
  return out
}

/** The headings of the whole README, as GitHub anchors them, so a link to a section the site does not host can still go to the README. */
function readmeSlugs(readme: string): Set<string> {
  const slugs = new Set<string>()
  for (const { line, fenced } of scanFences(readme)) {
    const m = fenced ? null : /^#{1,6}\s+(.*)$/.exec(line)
    if (m !== null) slugs.add(slugify((m[1] ?? '').replace(/[`*_]/g, '')))
  }
  return slugs
}

function commandsMarkdown(help: string): string {
  const usage = help.split('\n').find((l) => l.startsWith('USAGE')) ?? ''
  const rows = parseCommands(help).map((c) => `| \`${c.name}\` | ${c.summary.replace(/\|/g, '\\|')} |`)
  return [
    '`cw` is one program with subcommands. `cw <command> --help` explains each of them; this page lists what the top-level help prints.',
    '',
    '```',
    usage.replace(/^USAGE\s+/, ''),
    '```',
    '',
    '| Command | What it does |',
    '|---|---|',
    ...rows,
  ].join('\n')
}

export function docsPages(ctx: DocsCtx): BuiltPage[] {
  const { urls } = ctx
  const sections = sectionsOf(ctx.readme, ['Install', 'Quickstart', 'Cockpit (desktop)', 'Configuration'])
  const fromReadme = (name: string): string => {
    const prepared = prepareReadmeMarkdown(sections[name] ?? '')
    lintMarkdown(prepared)
    return shiftHeadings(prepared, -1)
  }

  const pages: DocPage[] = [
    { generated: true, slug: '', title: 'Documentation', description: 'Install, quickstart, concepts and reference for crossweave.', markdown: '' },
    { slug: 'install', title: 'Install', description: 'Install crossweave on macOS or Linux.', markdown: fromReadme('Install') },
    { slug: 'quickstart', title: 'Quickstart', description: 'Run two sessions on one repository and land them.', markdown: fromReadme('Quickstart') },
    { slug: 'concepts', title: 'Concepts', description: 'Sessions, the rail, landing, checks and checkpoints in a page.', markdown: ctx.concepts },
    { slug: 'cockpit', title: 'The Cockpit app', description: 'The macOS desktop app: the rail, panes, the composer, checks and settings.', markdown: fromReadme('Cockpit (desktop)') },
    { slug: 'configuration', title: 'Configuration', description: 'crossweave.config.json, trust and settings.', markdown: fromReadme('Configuration') },
    { generated: true, slug: 'commands', title: 'Command reference', description: 'The cw commands and what each one is for.', markdown: commandsMarkdown(ctx.cliHelp) },
  ]
  const index = pages[0]
  if (index !== undefined) {
    index.markdown = [
      'crossweave runs many sessions on one repository, each a git worktree plus your shell, and lands them back. These pages are the README and the reference, on the site.',
      '',
      ...pages.slice(1).map((p) => `- [${p.title}](${urls.path(`/docs/${p.slug}/`)}): ${p.description}`),
      '',
      `The source of truth is the repository: [README](${REPO_URL}#readme), and the limitations of every feature are written next to its design in \`docs/superpowers/specs/\`.`,
    ].join('\n')
  }

  // Pass 1: the ids each page will have, so a link to another page's heading can be resolved before anything is rendered for good.
  const ids = new Map<string, Set<string>>(pages.map((p) => [p.slug, new Set(renderMarkdown(p.markdown).headings.map((h) => h.id))]))
  const global = readmeSlugs(ctx.readme)

  const render = (page: DocPage): BuiltPage => {
    const here = `/docs/${page.slug === '' ? '' : `${page.slug}/`}`
    const rendered = renderMarkdown(page.markdown, {
      rewriteLink(href) {
        if (/^(https?:|mailto:)/.test(href)) return href
        if (href.startsWith('/')) return page.generated === true ? href : repoFile(href.slice(1))
        if (href.startsWith('#')) {
          const fragment = href.slice(1)
          if (ids.get(page.slug)?.has(fragment) === true) return href
          for (const [slug, set] of ids) if (set.has(fragment)) return `${urls.path(`/docs/${slug === '' ? '' : `${slug}/`}`)}#${fragment}`
          if (global.has(fragment)) return `${REPO_URL}#${fragment}`
          throw new Error(`docs${here}: the link ${href} points at nothing`)
        }
        return repoFile(href)
      },
      rewriteImage(src) {
        const m = /^docs\/images\/([\w-]+\.png)$/.exec(src)
        return m === null ? null : { src: urls.path(`/img/${m[1]}`), ...ctx.imageSize(m[1] ?? '') }
      },
    })
    if (rendered.droppedHtml > 0) throw new Error(`docs${here}: raw HTML is not supported in the documentation sources`)

    const nav = pages
      .map((p) => {
        const href = urls.path(`/docs/${p.slug === '' ? '' : `${p.slug}/`}`)
        return `<li><a href="${escapeHtml(href)}"${p.slug === page.slug ? ' aria-current="page"' : ''}>${escapeHtml(p.slug === '' ? 'Overview' : p.title)}</a></li>`
      })
      .join('\n')

    return {
      path: here,
      body: html(`<main id="main" class="page">
<div class="wrap docs">
<nav class="docs__nav" aria-label="Documentation">
<ul>
${nav}
</ul>
</nav>
<article class="prose">
<h1>${escapeHtml(page.title)}</h1>
<p class="docs__notice">These pages describe the main branch. The latest published release is ${escapeHtml(ctx.release.tag)}; features marked “In the next release” on the home page are not in it.</p>
${rendered.html}
</article>
</div>
</main>`),
      meta: {
        lang: 'en',
        path: here,
        title: page.slug === '' ? 'Documentation — crossweave' : `${page.title} — crossweave docs`,
        description: page.description,
        canonical: urls.abs(here),
        alternates: {},
        ogImage: urls.abs('/img/cockpit-sessions.png'),
      },
    }
  }

  return pages.map(render)
}
