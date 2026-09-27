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
  'workspace.openFile', 'workspace.listFiles',
  // The Terminal pane: a shell the daemon runs in a session's worktree.
  'terminal.open',
  'terminal.list',
  'terminal.attach',
  'terminal.input',
  'terminal.resize',
  'terminal.close',
  // Per-user settings and the launchers a new session can start with (daemon RPCs).
  'launchers.list',
  'settings.get',
  'settings.set',
  // Files in a session's worktree (the in-app editor) and branches to start from.
  'file.list',
  // What landing a session would bring in (the Changes pane).
  'session.diff',
  // Every project open in this window (handled by the bridge itself).
  'projects.list',
  'projects.sessions',
  'projects.close',
  'projects.pick',
  'projects.reorder',
  // The command bar's rename and gc.
  'session.rename',
  'workspace.gc',
  'file.read',
  'file.write',
  'git.branches',
  // Handled in the main process, not forwarded: open a file in the user's editor,
  // show a project's or session's folder in Finder or the editor, the Dock badge.
  'editor.open',
  'folder.reveal',
  'folder.openInEditor',
  'app.badge',
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
  // A project that is open but not active changed: its rail group should refresh.
  'project.invalidate',
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
