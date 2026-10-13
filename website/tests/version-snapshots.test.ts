import { describe, expect, test } from 'bun:test'
import { versionedDocsPages } from '../src/version-snapshots'
import { loadConfig, makeUrls } from '../src/site'

const urls = makeUrls(loadConfig({}))

function pngFixture(width: number, height: number): Uint8Array {
  const data = new Uint8Array(24)
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  new DataView(data.buffer).setUint32(16, width)
  new DataView(data.buffer).setUint32(20, height)
  return data
}

describe('released documentation snapshots', () => {
  test('renders the README at a tag as an English archive page with pinned repository links', () => {
    const [page] = versionedDocsPages({
      urls,
      snapshots: [{
        tag: 'v0.6.0',
        readme: '# Crossweave\n\n## Install\n\nSee [the guide](docs/install.md#setup) and [local setup](#setup).\n\n## Setup\n\nReady.\n',
      }],
    })

    expect(page?.path).toBe('/docs/versions/v0.6.0/')
    expect(String(page?.body)).toContain('Documentation snapshot for v0.6.0')
    expect(String(page?.body)).toContain('<h3 id="install">Install</h3>')
    expect(String(page?.body)).toContain('href="#setup"')
    expect(String(page?.body)).toContain('href="https://github.com/NMHx2005/crossweave/blob/v0.6.0/docs/install.md#setup"')
    expect(page?.meta.lang).toBe('en')
    expect(page?.meta.alternates).toEqual({})
  })

  test('rejects invalid release tags and links to missing local headings', () => {
    expect(() => versionedDocsPages({ urls, snapshots: [{ tag: 'v0.6.0;touch-pwned', readme: '# Safe' }] })).toThrow('invalid release tag')
    expect(() => versionedDocsPages({ urls, snapshots: [{ tag: 'v0.6.0', readme: '# Safe\n\n[Missing](#missing)' }] })).toThrow('points at nothing')
  })

  test('rejects unsupported raw HTML using the shared Markdown safety policy', () => {
    expect(() => versionedDocsPages({ urls, snapshots: [{ tag: 'v0.6.0', readme: '# Safe\n\n<script>alert(1)</script>' }] })).toThrow('raw HTML')
  })

  test('preserves the known release README screenshot and caption through the safe Markdown renderer', () => {
    const page = versionedDocsPages({
      urls,
      snapshots: [{
        tag: 'v0.6.0',
        readme: '# Release\n\n<p align="center"><img src="docs/images/cockpit-sessions.png" alt="Cockpit view" width="900"></p>\n<p align="center"><sub>A screenshot with <code>demo-shot.ts</code>.</sub></p>',
        images: [{ path: 'docs/images/cockpit-sessions.png', data: pngFixture(900, 500) }],
      }],
    })[0]
    expect(String(page?.body)).toContain('src="/crossweave/img/versions/v0.6.0/cockpit-sessions.png"')
    expect(String(page?.body)).toContain('width="900" height="500"')
    expect(String(page?.body)).toContain('alt="Cockpit view"')
    expect(String(page?.body)).toContain('A screenshot with <code>demo-shot.ts</code>.')
  })
})
