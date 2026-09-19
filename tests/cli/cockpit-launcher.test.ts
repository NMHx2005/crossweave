import { describe, expect, test } from 'bun:test'
import { cockpitAppPath, tryOpenCockpit, type CockpitLaunchDeps } from '../../src/cli/cockpit-launcher.js'

function deps(overrides: Partial<CockpitLaunchDeps> = {}): CockpitLaunchDeps {
  return {
    platform: 'darwin',
    arch: 'arm64',
    homeDir: '/Users/demo',
    cwd: '/repo with spaces',
    exists: () => true,
    launch: async () => 0,
    ...overrides,
  }
}

describe('cockpitAppPath', () => {
  test('uses the per-user Applications directory', () => {
    expect(cockpitAppPath('/Users/demo')).toBe('/Users/demo/Applications/crossweave Cockpit.app')
  })
})

describe('tryOpenCockpit', () => {
  test('does not try to open Cockpit off macOS arm64', async () => {
    let calls = 0
    const launch = async () => {
      calls += 1
      return 0
    }

    expect(await tryOpenCockpit(deps({ platform: 'linux', launch }))).toBe(false)
    expect(await tryOpenCockpit(deps({ arch: 'x64', launch }))).toBe(false)
    expect(calls).toBe(0)
  })

  test('does not launch when the managed app executable is absent', async () => {
    const checked: string[] = []
    const opened = await tryOpenCockpit(deps({
      exists: (path) => {
        checked.push(path)
        return false
      },
    }))

    expect(opened).toBe(false)
    expect(checked).toEqual([
      '/Users/demo/Applications/crossweave Cockpit.app/Contents/MacOS/crossweave Cockpit',
    ])
  })

  test('does not launch when the managed app is absent', async () => {
    let calls = 0
    const opened = await tryOpenCockpit(deps({
      exists: () => false,
      launch: async () => {
        calls += 1
        return 0
      },
    }))

    expect(opened).toBe(false)
    expect(calls).toBe(0)
  })

  test('launches through open with argv-safe project-root forwarding', async () => {
    const calls: string[][] = []
    const opened = await tryOpenCockpit(deps({
      launch: async (argv) => {
        calls.push([...argv])
        return 0
      },
    }))

    expect(opened).toBe(true)
    expect(calls).toEqual([[
      'open',
      '-n',
      '-a',
      '/Users/demo/Applications/crossweave Cockpit.app',
      '--args',
      '--project-root=/repo with spaces',
    ]])
  })

  test('falls back when LaunchServices exits non-zero', async () => {
    expect(await tryOpenCockpit(deps({ launch: async () => 1 }))).toBe(false)
  })

  test('falls back when LaunchServices cannot be spawned', async () => {
    expect(await tryOpenCockpit(deps({
      launch: async () => {
        throw new Error('open missing')
      },
    }))).toBe(false)
  })
})
