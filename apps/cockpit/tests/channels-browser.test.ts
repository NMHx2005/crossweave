import { describe, expect, test } from 'bun:test'
import { COCKPIT_CHANNELS, COCKPIT_EVENTS, isCockpitChannel } from '../electron/channels'

describe('the Browser pane channels', () => {
  test('the switch and the debug read are invoke channels, the activity line an event, and nothing broader', () => {
    expect(isCockpitChannel('browser.setAccess')).toBe(true)
    expect(isCockpitChannel('browser.errors')).toBe(true)
    expect(COCKPIT_EVENTS).toContain('browser.activity')
    // A bridge read or command (`browser.console`, `browser.navigate`, …) never travels
    // through the window: those are kinds served by main. `browser.errors` is the one
    // read the Debug pane makes straight to main, where the browser agent lives.
    expect(COCKPIT_CHANNELS.filter((c) => c.startsWith('browser.'))).toEqual(['browser.errors', 'browser.setAccess'])
  })
})
