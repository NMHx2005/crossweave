import { escapeHtml } from './site'
import { html as asHtml, type Html } from './types'

export interface ImageInfo {
  src: string
  width: number
  height: number
}

export interface RenderOptions {
  /** Maps an image src to a site image with its size, or null to drop it. The default drops every image. */
  rewriteImage?(src: string): ImageInfo | null
  rewriteLink?(href: string): string
  /** Put before every heading id, so several documents on one page cannot repeat an id. */
  idPrefix?: string
}

export interface Rendered {
  html: Html
  headings: Array<{ level: number; text: string; id: string }>
  droppedHtml: number
}

// Bun's markdown API is documented as unstable, and `Bun.markdown.html` keeps raw HTML (an `onerror` attribute, a `javascript:` link).
// Every element therefore has a callback of ours: an element without one is rendered as its bare children, which silently flattens it.
// `text` is the only callback that receives raw text and the only one that escapes; every other callback receives already-rendered HTML.
interface MarkdownApi {
  render(source: string, callbacks: Record<string, (children: string, meta?: Record<string, unknown>) => string>): string
}
const markdown = (Bun as unknown as { markdown: MarkdownApi }).markdown

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto'])

function safeHref(href: string): boolean {
  // Browsers ignore whitespace and control characters inside a scheme (`java\tscript:`), so test the href as a browser reads it.
  const cleaned = href.replace(/[\u0000- \u007f]/g, '')
  if (cleaned === '' || cleaned.startsWith('//')) return false
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned)
  return scheme === null ? true : ALLOWED_SCHEMES.has((scheme[1] ?? '').toLowerCase())
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

/** The plain text of already-rendered inline HTML: tags removed, the five entities this renderer emits decoded. */
function plainText(rendered: string): string {
  return rendered.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e)
}

export function slugify(text: string): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return base === '' ? 'section' : base
}

const align = (meta?: Record<string, unknown>): string => {
  const a = meta?.['align']
  return a === 'left' || a === 'center' || a === 'right' ? ` class="is-${a}"` : ''
}

export function renderMarkdown(source: string, options: RenderOptions = {}): Rendered {
  const headings: Rendered['headings'] = []
  const used = new Map<string, number>()
  let droppedHtml = 0

  const uniqueId = (text: string): string => {
    const base = slugify(text)
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return `${options.idPrefix ?? ''}${n === 1 ? base : `${base}-${n}`}`
  }

  const link = (children: string, meta?: Record<string, unknown>): string => {
    const original = String(meta?.['href'] ?? '')
    if (!safeHref(original)) return children
    const href = options.rewriteLink === undefined ? original : options.rewriteLink(original)
    if (!safeHref(href)) return children
    const title = meta?.['title']
    const titleAttr = typeof title === 'string' && title !== '' ? ` title="${escapeHtml(title)}"` : ''
    return `<a href="${escapeHtml(href)}"${titleAttr}>${children}</a>`
  }

  const image = (children: string, meta?: Record<string, unknown>): string => {
    const found = options.rewriteImage?.(String(meta?.['src'] ?? '')) ?? null
    if (found === null) return ''
    return `<img src="${escapeHtml(found.src)}" alt="${escapeHtml(plainText(children))}" width="${found.width}" height="${found.height}" loading="lazy">`
  }

  const rendered = markdown.render(source, {
    text: (t) => escapeHtml(t),
    html: () => {
      droppedHtml += 1
      return ''
    },
    heading: (children, meta) => {
      const level = Math.min(6, Math.max(1, Number(meta?.['level'] ?? 1)))
      const text = plainText(children)
      const id = uniqueId(text)
      headings.push({ level, text, id })
      return `<h${level} id="${id}">${children}</h${level}>\n`
    },
    paragraph: (c) => `<p>${c}</p>\n`,
    strong: (c) => `<strong>${c}</strong>`,
    emphasis: (c) => `<em>${c}</em>`,
    strikethrough: (c) => `<del>${c}</del>`,
    codespan: (c) => `<code>${c}</code>`,
    code: (c, meta) => {
      const language = typeof meta?.['language'] === 'string' ? meta['language'].replace(/[^A-Za-z0-9_+-]/g, '') : ''
      return `<pre><code${language === '' ? '' : ` class="language-${language}"`}>${c}</code></pre>\n`
    },
    link,
    image,
    list: (c, meta) => {
      if (meta?.['ordered'] !== true) return `<ul>\n${c}</ul>\n`
      const start = Number(meta['start'] ?? 1)
      return `<ol${Number.isInteger(start) && start !== 1 ? ` start="${start}"` : ''}>\n${c}</ol>\n`
    },
    listItem: (c) => `<li>${c}</li>\n`,
    table: (c) => `<table>\n${c}</table>\n`,
    thead: (c) => `<thead>\n${c}</thead>\n`,
    tbody: (c) => `<tbody>\n${c}</tbody>\n`,
    tr: (c) => `<tr>${c}</tr>\n`,
    th: (c, meta) => `<th scope="col"${align(meta)}>${c}</th>`,
    td: (c, meta) => `<td${align(meta)}>${c}</td>`,
    blockquote: (c) => `<blockquote>\n${c}</blockquote>\n`,
    hr: () => '<hr>\n',
  })

  return { html: asHtml(rendered), headings, droppedHtml }
}

/**
 * Refuses what the renderer cannot do (task lists, footnotes, math) and raw HTML at the start of a line, naming the line.
 * A construct it does not know about degrades to its text; the golden tests over the real documents are what notice that.
 */
export function lintMarkdown(source: string): void {
  let fenced = false
  source.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      return
    }
    if (fenced) return
    const where = `line ${index + 1}`
    if (/^\s*[-*+]\s+\[[ xX]\]\s/.test(line)) throw new Error(`markdown: task lists are not supported (${where})`)
    if (/\[\^[^\]]+\]/.test(line)) throw new Error(`markdown: footnotes are not supported (${where})`)
    if (/\$\$/.test(line)) throw new Error(`markdown: math is not supported (${where})`)
    if (/^\s*<\/?[A-Za-z][^>]*>/.test(line)) throw new Error(`markdown: raw HTML is not supported (${where})`)
  })
}
