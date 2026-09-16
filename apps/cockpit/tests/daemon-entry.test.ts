import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCrossweaveRoot, resolveCockpitDaemonEntry } from '../electron/daemon-entry'

describe('findCrossweaveRoot', () => {
  test('walks up until src/daemon/main.ts and rpc-client exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-root-'))
    mkdirSync(join(root, 'src', 'daemon'), { recursive: true })
    mkdirSync(join(root, 'src', 'client'), { recursive: true })
    writeFileSync(join(root, 'src', 'daemon', 'main.ts'), '')
    writeFileSync(join(root, 'src', 'client', 'rpc-client.ts'), '')
    const nested = join(root, 'apps', 'cockpit', 'electron')
    mkdirSync(nested, { recursive: true })
    expect(findCrossweaveRoot(nested)).toBe(root)
  })

  test('throws when no repo root is found', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cw-empty-'))
    expect(() => findCrossweaveRoot(empty)).toThrow(/crossweave repo root/)
  })
})

describe('resolveCockpitDaemonEntry', () => {
  test('points bun at src/daemon/main.ts', () => {
    const entry = resolveCockpitDaemonEntry('/repo', '/usr/bin/bun')
    expect(entry).toEqual({
      command: '/usr/bin/bun',
      args: ['/repo/src/daemon/main.ts'],
    })
  })
})
