import { describe, expect, test } from 'bun:test'
import { recentMenuItems } from '../electron/recent-menu'

const deps = (over: Partial<Parameters<typeof recentMenuItems>[1]> = {}) => ({
  exists: () => true,
  home: '/Users/me',
  open: () => undefined,
  clear: () => undefined,
  ...over,
})

describe('recentMenuItems', () => {
  test('lists recents newest first, with the home directory shown as ~', () => {
    const items = recentMenuItems(['/Users/me/code/a', '/srv/b'], deps())
    expect(items.slice(0, 2).map((i) => i.label)).toEqual(['~/code/a', '/srv/b'])
  })

  // Replacing the whole submenu with the list used to drop this item exactly when
  // there was something to clear.
  test('keeps Clear Recent below the list, enabled only when there is something to clear', () => {
    const some = recentMenuItems(['/srv/a'], deps())
    expect(some.at(-1)).toMatchObject({ label: 'Clear Recent', enabled: true })
    const none = recentMenuItems([], deps())
    expect(none.map((i) => i.label)).toEqual(['No Recent Folders', 'Clear Recent'])
    expect(none.at(-1)).toMatchObject({ enabled: false })
  })

  test('shows a folder that no longer exists as disabled rather than a dead click', () => {
    const items = recentMenuItems(['/gone', '/here'], deps({ exists: (p) => p === '/here' }))
    expect(items[0]).toMatchObject({ enabled: false })
    expect(items[1]).toMatchObject({ enabled: true })
  })

  test('clicking opens that folder; Clear Recent calls clear', () => {
    const opened: string[] = []
    let cleared = 0
    const items = recentMenuItems(['/srv/a'], deps({ open: (r) => opened.push(r), clear: () => { cleared++ } }))
    items[0]!.click?.()
    items.at(-1)!.click?.()
    expect(opened).toEqual(['/srv/a'])
    expect(cleared).toBe(1)
  })
})
