import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ACTIVITY_BADGE, ACTIVITY_LABEL } from '../src/lib/activity'
import type { ActivityKind } from '../../../src/domain/activity.js'

const cockpitRoot = fileURLToPath(new URL('..', import.meta.url))
const css = readFileSync(`${cockpitRoot}src/ui/app.css`, 'utf8')

const KINDS: ActivityKind[] = ['blocked', 'needs_you', 'landed', 'land_failed']

describe('activity rows', () => {
  test('every kind the feed can hold has a word and a badge', () => {
    for (const kind of KINDS) {
      expect(ACTIVITY_LABEL[kind].length).toBeGreaterThan(0)
      expect(ACTIVITY_BADGE[kind].length).toBeGreaterThan(0)
    }
  })

  test('every badge a row wears is a class the stylesheet actually defines', () => {
    // The `Record<ActivityKind, ...>` above is the exhaustiveness guard; this is the
    // drift guard — a name that matches no rule renders an unstyled span, which reads as
    // a kind the design system does not have.
    for (const kind of KINDS) {
      expect(css).toContain(`.cockpit-rail__badge--${ACTIVITY_BADGE[kind]} {`)
    }
  })
})
