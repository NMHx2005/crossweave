import { describe, expect, test } from 'bun:test'
import { switchCockpitWorkspace } from '../electron/workspace-switch'

describe('switchCockpitWorkspace', () => {
  // The window used to be destroyed and rebuilt, taking every project's live panes
  // with it; now it is asked to show the project, and only created when there is none.
  test('shows the project in the window once it has attached, then brings the window forward', async () => {
    const events: string[] = []

    await switchCockpitWorkspace('/repo/two', {
      ensure: async (projectRoot) => { events.push(`ensure:${projectRoot}`) },
      reveal: (projectRoot) => {
        events.push(`reveal:${projectRoot}`)
        return {
          show: () => { events.push('show') },
          focus: () => { events.push('focus') },
        }
      },
    })

    expect(events).toEqual(['ensure:/repo/two', 'reveal:/repo/two', 'show', 'focus'])
  })

  test('a project that fails to attach is not shown', async () => {
    let reveals = 0

    await expect(switchCockpitWorkspace('/repo/broken', {
      ensure: async () => { throw new Error('connect failed') },
      reveal: () => {
        reveals += 1
        return { show: () => undefined, focus: () => undefined }
      },
    })).rejects.toThrow(/connect failed/)

    expect(reveals).toBe(0)
  })
})
