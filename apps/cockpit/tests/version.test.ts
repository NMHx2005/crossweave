/**
 * The cockpit is shipped alongside the CLI it talks to, and `electron-builder`
 * names the dmg/zip from this package's own version — so a stale literal here
 * shows up only in an artifact filename (`crossweave Cockpit-0.0.0-arm64.dmg`),
 * which is exactly the kind of thing nobody notices until they ship one.
 * Keeping the two in lockstep is the whole guard.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cockpitRoot = fileURLToPath(new URL('..', import.meta.url))
const version = (path: string): string =>
  (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version

describe('cockpit package version', () => {
  it('matches the core package version', () => {
    expect(version(`${cockpitRoot}package.json`)).toBe(version(`${cockpitRoot}../../package.json`))
  })

  it('is not the scaffold placeholder', () => {
    expect(version(`${cockpitRoot}package.json`)).not.toBe('0.0.0')
  })
})
