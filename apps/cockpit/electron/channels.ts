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
  // Delete: the session's row, worktree and branch (after a kill when it is live).
  'session.rm',
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
  // The Open Recent history (main process), for the rail's empty-area menu.
  'projects.recent',
  // Before opening a folder: is it a repository? (main process; see folder-open.ts)
  'folder.inspect',
  // The Open folder dialog's "Initialize git here", after the user confirmed.
  'folder.initGit',
  // The Open folder dialog's "Open as a plain folder": remember the choice (main process).
  'folder.openPlain',
  // The command bar's rename and gc.
  'session.rename',
  // A session's one-line note (shown in the rail instead of the agent's last words).
  'session.note',
  // Run the project's trusted test command in a session's worktree (the verdict arrives on the session list).
  'session.check',
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
  // Settings → Terminal: which of Ghostty / iTerm2 have settings here, and a read-only
  // import of one (the renderer saves it through settings.set).
  'terminal.importSources',
  'terminal.import',
  // Settings → Appearance / Terminal: the font families installed on this Mac.
  'fonts.list',
  // Settings saved new shortcuts: rebuild the menu from the settings file.
  'menu.refresh',
  // The prompt composer's Refine: the draft through the user's own command (from the saved settings), back as a proposal.
  'prompt.refine',
  // A shell command's request (cw pane) was carried out or refused by the window: the answer.
  'bridge.reply',
  // The Browser pane's access switch (off / read / control) and the webview it belongs to; main enforces it.
  'browser.setAccess',
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
  // A shell command asks the window to arrange its panes (answered on the bridge.reply channel).
  'cockpit.bridge',
  // What an agent just did to a Browser pane (and 'detached' when the debugger went away): the activity line.
  'browser.activity',
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
