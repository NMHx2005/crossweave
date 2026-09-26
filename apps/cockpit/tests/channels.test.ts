import { describe, expect, test } from 'bun:test'
import {
  COCKPIT_CHANNELS,
  COCKPIT_EVENTS,
  isCockpitChannel,
  isCockpitEvent,
} from '../electron/channels'
import { isForwardedNotification } from '../electron/daemon-bridge'

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

describe('the session.exit event', () => {
  test('is in the closed event allowlist, because a pane needs it to explain a blank screen', () => {
    // Without it the renderer never hears that the agent ended: the alt-screen restore
    // leaves an empty pane and no message (measured: 305 chars of agent TUI → 0 after a
    // stop, with the pane element unchanged).
    expect(COCKPIT_EVENTS).toContain('session.exit')
    expect(isCockpitEvent('session.exit')).toBe(true)
  })

  test('is forwarded by the bridge, unlike an unknown event', () => {
    expect(isForwardedNotification('session.exit')).toBe(true)
    expect(isForwardedNotification('session.something-else')).toBe(false)
  })
})

describe('terminal channels', () => {
  // The Terminal pane's shell lives in the daemon; the renderer only reaches it
  // through these named channels and events.
  test('allows the terminal RPCs and events, and nothing broader', async () => {
    const { isCockpitChannel, isCockpitEvent } = await import('../electron/channels')
    for (const ch of ['terminal.open', 'terminal.list', 'terminal.attach', 'terminal.input', 'terminal.resize', 'terminal.close']) {
      expect(isCockpitChannel(ch)).toBe(true)
    }
    expect(isCockpitEvent('terminal.data')).toBe(true)
    expect(isCockpitEvent('terminal.exit')).toBe(true)
    expect(isCockpitChannel('terminal.exec')).toBe(false)
  })
})
