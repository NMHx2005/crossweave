import { describe, expect, test } from 'bun:test'
import { COCKPIT_CHANNELS, COCKPIT_EVENTS, isCockpitChannel } from '../electron/channels'

describe('the Browser pane channels', () => {
  test('the switch is an invoke channel and the activity line an event, and nothing broader', () => {
    expect(isCockpitChannel('browser.setAccess')).toBe(true)
    expect(COCKPIT_EVENTS).toContain('browser.activity')
    // A read or a command never travels through the window: those are bridge kinds served by main.
    expect(COCKPIT_CHANNELS.filter((c) => c.startsWith('browser.'))).toEqual(['browser.setAccess'])
  })
})
