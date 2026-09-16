import { describe, expect, test } from 'bun:test'
import {
  COCKPIT_CHANNELS,
  COCKPIT_EVENTS,
  isCockpitChannel,
  isCockpitEvent,
} from '../electron/channels'

describe('cockpit IPC allowlist', () => {
  test('invoke channels are a closed set', () => {
    expect(COCKPIT_CHANNELS.length).toBeGreaterThan(0)
    for (const channel of COCKPIT_CHANNELS) {
      expect(isCockpitChannel(channel)).toBe(true)
    }
    expect(isCockpitChannel('evil.channel')).toBe(false)
    expect(isCockpitChannel('session.resume')).toBe(true)
    expect(isCockpitChannel('session.start')).toBe(true)
  })

  test('listen events are a closed set', () => {
    expect(COCKPIT_EVENTS.length).toBeGreaterThan(0)
    for (const event of COCKPIT_EVENTS) {
      expect(isCockpitEvent(event)).toBe(true)
    }
    expect(isCockpitEvent('evil.event')).toBe(false)
  })
})
