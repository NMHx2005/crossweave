/** Closed invoke channel allowlist — daemon RPC names, plus workspace.ensure / session.detach. */
export const COCKPIT_CHANNELS = [
  'workspace.ensure',
  'session.list',
  'session.new',
  'session.start',
  'session.resume',
  'session.attach',
  'session.detach',
  'session.input',
  'session.resize',
  'session.stop',
  'session.kill',
  'converge.status',
  'land.session',
  'journal.get',
  'journal.set',
  'usage.summary', 'workspace.openFile', 'workspace.listFiles',
  'session.wait',
  'session.unwait',
  // The Terminal pane: a shell the daemon runs in a session's worktree.
  'terminal.open',
  'terminal.list',
  'terminal.attach',
  'terminal.input',
  'terminal.resize',
  'terminal.close',
  // The agent catalog and per-user settings (daemon RPCs).
  'agents.list',
  'settings.get',
  'settings.set',
  // Files in a session's worktree (the in-app editor) and branches to start from.
  'file.list',
  'file.read',
  'file.write',
  'git.branches',
  // Handled in the main process, not forwarded: open a file in the user's editor.
  'editor.open',
] as const

export type CockpitChannel = (typeof COCKPIT_CHANNELS)[number]

/** Closed push-event allowlist for renderer subscriptions. */
export const COCKPIT_EVENTS = [
  'session.data',
  // The agent process ended. Not a data chunk, so it needs its own event: an agent
  // TUI runs on the terminal's alternate screen, and when the process exits the
  // terminal correctly restores the (empty) primary buffer — leaving the user staring
  // at a blank pane with no explanation, which is exactly what "stop" used to do.
  'session.exit',
  'tui.event',
  'tui.invalidate',
  'daemon.gone',
  'terminal.data',
  'terminal.exit',
  // A menu accelerator fired (⌘T, ⌘⇧A): the renderer decides what it means.
  'cockpit.command',
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
