/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import type { ComponentChildren, VNode } from 'preact'
import { SENSITIVE_REASON } from '../../../src/core/sensitive-files'
import { SensitiveBadge, SensitiveSummary } from '../src/ui/SensitiveBadge'

type Found = { texts: string[]; nodes: VNode<Record<string, any>>[] }
function walk(node: ComponentChildren, out: Found = { texts: [], nodes: [] }): Found {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  const vnode = node as VNode<Record<string, any>>
  if (typeof vnode.type === 'function') return walk((vnode.type as (props: unknown) => ComponentChildren)(vnode.props), out)
  out.nodes.push(vnode)
  return walk(vnode.props['children'] as ComponentChildren, out)
}
const text = (f: Found): string => f.texts.join('')

describe('SensitiveBadge', () => {
  test('an ordinary file carries nothing', () => {
    expect(SensitiveBadge({ path: 'src/index.ts' })).toBeNull()
    expect(SensitiveBadge({ path: '' })).toBeNull()
  })

  test('a flagged file is named by a word, with the reason on hover and in the text assistive technology reads', () => {
    const badge = SensitiveBadge({ path: 'apps/web/.env.production' })!
    expect(badge.props['class']).toBe('cockpit-sensitive is-secret')
    expect(badge.props['title']).toBe(SENSITIVE_REASON.secret)
    const found = walk(badge)
    expect(text(found)).toBe(`secret — ${SENSITIVE_REASON.secret}`)
    expect(found.nodes.some((n) => String(n.props['class']) === 'cockpit-sr-only')).toBe(true)
  })

  test('each kind gets its own class', () => {
    const cls = (path: string): string => String(SensitiveBadge({ path })!.props['class'])
    expect(cls('.github/workflows/ci.yml')).toContain('is-automation')
    expect(cls('db/migrate/1.rb')).toContain('is-migration')
    expect(cls('package.json')).toContain('is-dependency')
  })
})

describe('SensitiveSummary', () => {
  test('says nothing when nothing is flagged', () => {
    expect(SensitiveSummary({ paths: [] })).toBeNull()
    expect(SensitiveSummary({ paths: ['src/a.ts', 'README.md'] })).toBeNull()
  })

  test('counts the flagged files, the kinds that make Land ask first', () => {
    const line = text(walk(SensitiveSummary({ paths: ['package.json', 'src/a.ts', '.github/workflows/ci.yml', '.env.production'] })))
    expect(line).toBe('3 sensitive files: 1 secret · 1 automation · 1 dependency')
  })

  test('one file is singular', () => {
    expect(text(walk(SensitiveSummary({ paths: ['bun.lock'] })))).toBe('1 sensitive file: 1 dependency')
  })
})
