/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import type { ComponentChildren, VNode } from 'preact'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as kit from '../src/ui/SettingsKit'
import { SettingsDetails } from '../src/ui/SettingsKit'

type Found = { texts: string[]; nodes: VNode<Record<string, unknown>>[] }
function walk(node: ComponentChildren, out: Found = { texts: [], nodes: [] }): Found {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  const vnode = node as VNode<Record<string, unknown>>
  if (typeof vnode.type === 'function') return walk((vnode.type as (props: unknown) => ComponentChildren)(vnode.props), out)
  out.nodes.push(vnode)
  return walk(vnode.props['children'] as ComponentChildren, out)
}
const children = (vnode: VNode<Record<string, unknown>>): VNode<Record<string, unknown>>[] =>
  ([] as ComponentChildren[]).concat(vnode.props['children'] as ComponentChildren).filter((c): c is VNode<Record<string, unknown>> => typeof c === 'object' && c !== null)

describe('the news banner', () => {
  test('is gone from the kit and from the stylesheet (the page opens on the Dashboard, so a mark for it would never be seen)', () => {
    expect('Banner' in kit).toBe(false)
    const css = readFileSync(fileURLToPath(new URL('../src/ui/app.css', import.meta.url)), 'utf8')
    expect(css).not.toContain('cockpit-sbanner')
    expect(css).not.toContain('cockpit-snew')
  })
})

describe('SettingsDetails', () => {
  test('is a details element with its summary first and the body as a sibling, not inside the summary or a paragraph', () => {
    const root = walk(<SettingsDetails>Folded words</SettingsDetails>).nodes[0]
    expect(root?.type).toBe('details')
    const [first, second] = children(root as VNode<Record<string, unknown>>)
    expect(first?.type).toBe('summary')
    expect(walk(first).texts.join('')).toBe('Details')
    expect(second?.type).toBe('p')
    expect(walk(second).texts.join('')).toBe('Folded words')
  })
})
