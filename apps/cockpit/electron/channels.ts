/** Closed invoke channel allowlist — daemon RPC names, plus workspace.ensure / session.detach. */
export const COCKPIT_CHANNELS = [
  'workspace.ensure',
  'session.list',
  'session.new',
  'session.attach',
  'session.detach',
  'session.input',
  'session.resize',
  'session.stop',
  'session.kill',
  'converge.status',
  'land.session',
] as const

export type CockpitChannel = (typeof COCKPIT_CHANNELS)[number]

/** Closed push-event allowlist for renderer subscriptions. */
export const COCKPIT_EVENTS = [
  'session.data',
  'tui.event',
  'tui.invalidate',
  'daemon.gone',
] as const

export type CockpitEvent = (typeof COCKPIT_EVENTS)[number]

const channelSet = new Set<string>(COCKPIT_CHANNELS)
const eventSet = new Set<string>(COCKPIT_EVENTS)

export function isCockpitChannel(channel: string): channel is CockpitChannel {
  return channelSet.has(channel)
}

export function isCockpitEvent(event: string): event is CockpitEvent {
  return eventSet.has(event)
}
