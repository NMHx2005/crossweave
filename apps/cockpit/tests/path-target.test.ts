import { describe, expect, test } from 'bun:test'
import { badgeCount, folderLaunch, resolveFolder } from '../electron/path-target'

describe('resolveFolder', () => {
  const sessions = async (root: string) => root === '/w/api'
    ? [{ id: 's1', worktreePath: '/w/api/.crossweave/worktrees/s1' }, { id: 's2', worktreePath: null }]
    : []
  // The renderer names a project or a session; the path comes from what main knows.
  test('an open project, or a session its daemon lists — nothing else', async () => {
    expect(await resolveFolder({ projectRoot: '/w/api' }, ['/w/api'], sessions)).toBe('/w/api')
    expect(await resolveFolder({ projectRoot: '/etc' }, ['/w/api'], sessions)).toBeNull()
    expect(await resolveFolder({ projectRoot: '/w/api', sessionId: 's1' }, ['/w/api'], sessions)).toBe('/w/api/.crossweave/worktrees/s1')
    expect(await resolveFolder({ projectRoot: '/w/api', sessionId: 's2' }, ['/w/api'], sessions)).toBeNull()
    expect(await resolveFolder({ projectRoot: '/w/api', sessionId: 7 }, ['/w/api'], sessions)).toBeNull()
    // A session id is only looked up in an open project.
    expect(await resolveFolder({ projectRoot: '/w/web', sessionId: 's1' }, ['/w/api'], sessions)).toBeNull()
    expect(await resolveFolder({ path: '/etc' }, ['/w/api'], sessions)).toBeNull()
    expect(await resolveFolder(null, ['/w/api'], sessions)).toBeNull()
  })
})

describe('folderLaunch', () => {
  test('editor URLs name the folder without a line:col; a custom command gets it as {file}', () => {
    expect(folderLaunch({ kind: 'vscode' }, '/w/api')).toEqual({ kind: 'url', url: 'vscode://file/w/api' })
    expect(folderLaunch({ kind: 'custom', command: 'subl {file}' }, '/w/api')).toEqual({ kind: 'exec', argv: ['subl', '/w/api'] })
    expect(folderLaunch({ kind: 'custom', command: 'subl "{file}:{line}:{col}"' }, '/w/api')).toEqual({ kind: 'exec', argv: ['subl', '/w/api'] })
  })
})

describe('badgeCount', () => {
  test('a small whole number, or nothing', () => {
    expect(badgeCount({ count: 3 })).toBe(3)
    expect(badgeCount({ count: 0 })).toBe(0)
    expect(badgeCount({ count: -1 })).toBeNull()
    expect(badgeCount({ count: 1.5 })).toBeNull()
    expect(badgeCount('3')).toBeNull()
  })
})
