import { execFileSync } from 'node:child_process'
import { escapeHtml, REPO_URL, type Urls } from './site'
import { lintMarkdown, renderMarkdown } from './markdown'
import { shiftHeadings } from './readme'
import { html, type BuiltPage } from './types'

export interface VersionSnapshot {
  tag: string
  readme: string
  images?: readonly { path: string; data: Uint8Array }[]
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/

export function readVersionReadme(repoRoot: string, tag: string): VersionSnapshot {
  assertReleaseTag(tag)
  let readme: string
  try {
    readme = execFileSync('git', ['show', `${tag}:README.md`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error(`release ${tag}: could not read README.md from the Git tag`)
  }
  const imagePaths = new Set([...readme.matchAll(/docs\/images\/([\w-]+\.png)/g)].map((match) => `docs/images/${match[1] ?? ''}`))
  const images = [...imagePaths].map((path) => {
    try {
      const data = execFileSync('git', ['show', `${tag}:${path}`], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
      return { path, data }
    } catch {
      throw new Error(`release ${tag}: could not read ${path} from the Git tag`)
    }
  })
  return { tag, readme, images }
}

function assertReleaseTag(tag: string): void {
  if (!RELEASE_TAG.test(tag)) throw new Error(`invalid release tag: ${tag}`)
}

export function versionedDocsPages(input: { urls: Urls; snapshots: readonly VersionSnapshot[] }): BuiltPage[] {
  const seen = new Set<string>()
  return input.snapshots.map(({ tag, readme, images = [] }) => {
    assertReleaseTag(tag)
    if (seen.has(tag)) throw new Error(`duplicate release tag: ${tag}`)
    seen.add(tag)
    const imageMap = new Map(images.map((image) => [image.path, image.data]))
    const markdownSource = readme.split('\n').map((line) => {
      const gallery = /^<p align="center">((?:<img src="docs\/images\/[\w-]+\.png" alt="[^"]*" width="\d+">\s*)+)<\/p>$/.exec(line)
      if (gallery !== null) {
        return [...(gallery[1] ?? '').matchAll(/<img src="(docs\/images\/[\w-]+\.png)" alt="([^"]*)" width="\d+">/g)]
          .map((image) => `![${image[2] ?? ''}](${image[1] ?? ''})`).join('  ')
      }
      const caption = /^<p align="center"><sub>(.*?)<\/sub><\/p>$/.exec(line)
      if (caption !== null) {
        const text = (caption[1] ?? '').replace(/<code>/g, '`').replace(/<\/code>/g, '`')
        return /[<>]/.test(text) ? line : text
      }
      return line
    }).join('\n')
    try {
      lintMarkdown(markdownSource)
    } catch (error) {
      throw new Error(`${tag}: ${error instanceof Error ? error.message : 'invalid README Markdown'}`)
    }
    const markdown = shiftHeadings(markdownSource, 1)
    const headingIds = new Set(renderMarkdown(markdown).headings.map(({ id }) => id))
    const rendered = renderMarkdown(markdown, {
      rewriteLink(href) {
        if (/^(https?:|mailto:)/.test(href)) return href
        if (href.startsWith('#')) {
          if (!headingIds.has(href.slice(1))) throw new Error(`${tag}: the link ${href} points at nothing`)
          return href
        }
        if (href.startsWith('/')) return `${REPO_URL}/tree/${tag}${href}`
        return `${REPO_URL}/blob/${tag}/${href}`
      },
      rewriteImage(src) {
        const data = imageMap.get(src)
        if (data === undefined) return null
        if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) throw new Error(`${tag}: ${src} is not a PNG`)
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        return { src: input.urls.path(`/img/versions/${tag}/${src.slice('docs/images/'.length)}`), width: view.getUint32(16), height: view.getUint32(20) }
      },
    })
    if (rendered.droppedHtml > 0) throw new Error(`${tag}: raw HTML in the README is not supported`)
    const path = `/docs/versions/${tag}/`
    return {
      path,
      body: html(`<main id="main" class="page"><div class="wrap prose docs-version">
<h1>Documentation snapshot for ${escapeHtml(tag)}</h1>
<p class="docs__notice">This page reproduces the project README from the ${escapeHtml(tag)} release. It is in English.</p>
${rendered.html}
</div></main>`),
      meta: {
        lang: 'en',
        path,
        title: `${tag} documentation snapshot — crossweave`,
        description: `The README documentation as published with crossweave ${tag}.`,
        canonical: input.urls.abs(path),
        alternates: {},
        ogImage: input.urls.abs('/img/cockpit-sessions.png'),
      },
    }
  })
}
