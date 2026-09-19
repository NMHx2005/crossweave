import { describe, expect, test } from 'bun:test'
import { switchCockpitWorkspace } from '../electron/workspace-switch'

describe('switchCockpitWorkspace', () => {
  test('recreates and focuses the window only after the new workspace attaches', async () => {
    const events: string[] = []

    await switchCockpitWorkspace('/repo/two', {
      ensure: async (projectRoot) => { events.push(`ensure:${projectRoot}`) },
      recreateWindow: () => {
        events.push('recreate')
        return {
          show: () => { events.push('show') },
          focus: () => { events.push('focus') },
        }
      },
    })

    expect(events).toEqual(['ensure:/repo/two', 'recreate', 'show', 'focus'])
  })

  test('keeps the current window when the new workspace cannot attach', async () => {
    let recreates = 0

    await expect(switchCockpitWorkspace('/repo/broken', {
      ensure: async () => { throw new Error('connect failed') },
      recreateWindow: () => {
        recreates += 1
        return { show: () => undefined, focus: () => undefined }
      },
    })).rejects.toThrow(/connect failed/)

    expect(recreates).toBe(0)
  })
})
