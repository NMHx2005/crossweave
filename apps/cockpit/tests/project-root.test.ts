import { describe, expect, test } from 'bun:test'
import { projectRootFromAdditionalData, projectRootFromArgv, resolveLaunchProjectRoot } from '../electron/project-root'

describe('projectRootFromArgv', () => {
  test('reads the explicit project root from any argv position', () => {
    expect(projectRootFromArgv([
      '/Applications/crossweave Cockpit.app/Contents/MacOS/crossweave Cockpit',
      '--project-root=/repo',
    ])).toBe('/repo')
  })

  test('keeps spaces in the project root', () => {
    expect(projectRootFromArgv(['electron', '--project-root=/repo with spaces'])).toBe('/repo with spaces')
  })

  test('ignores an empty or malformed project-root argument', () => {
    expect(projectRootFromArgv(['electron', '--project-root='])).toBeUndefined()
    expect(projectRootFromArgv(['electron', '--project-root'])).toBeUndefined()
    expect(projectRootFromArgv(['electron'])).toBeUndefined()
    expect(projectRootFromArgv(['electron', '--project-root=relative/repo'])).toBeUndefined()
  })
})

describe('resolveLaunchProjectRoot', () => {
  test('argv wins over the development environment seam', () => {
    expect(resolveLaunchProjectRoot(['electron', '--project-root=/argv'], '/env')).toBe('/argv')
  })

  test('falls back to a non-empty environment root', () => {
    expect(resolveLaunchProjectRoot(['electron'], '/env')).toBe('/env')
    expect(resolveLaunchProjectRoot(['electron'], '')).toBeUndefined()
    expect(resolveLaunchProjectRoot(['electron'], 'relative/repo')).toBeUndefined()
  })
})


describe('projectRootFromAdditionalData', () => {
  test('accepts only a non-empty projectRoot string', () => {
    expect(projectRootFromAdditionalData({ projectRoot: '/forwarded' })).toBe('/forwarded')
    expect(projectRootFromAdditionalData({ projectRoot: '' })).toBeUndefined()
    expect(projectRootFromAdditionalData({ projectRoot: 42 })).toBeUndefined()
    expect(projectRootFromAdditionalData({ projectRoot: 'relative/repo' })).toBeUndefined()
    expect(projectRootFromAdditionalData(null)).toBeUndefined()
  })
})
