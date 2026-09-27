import type { MenuItemConstructorOptions } from 'electron'
import type { RecentMenuItem } from './recent-menu'

export type CockpitCommand = 'command-bar' | 'new-agent' | 'jump-attention' | 'open-terminal' | 'open-file' | 'open-browser' | 'open-settings'
  | 'open-project' | 'split-right' | 'split-down' | 'close-pane' | 'toggle-sidebar'
  | 'find' | 'find-next' | 'find-prev'
  /** ⌘1…⌘9: the Nth session down the rail. */
  | `jump-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

const JUMP_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

export interface AppMenuDeps {
  platform: NodeJS.Platform
  recent: RecentMenuItem[]
  /** A menu accelerator fired; the renderer owns what it does. */
  command(name: CockpitCommand): void
}

/**
 * The application menu. Pure (no Electron runtime), so its shape is testable.
 *
 * Built from Electron's own roles wherever one exists. The first custom menu
 * replaced the default wholesale with File/View/Window and lost Edit — and on macOS
 * Cmd+C, Cmd+V and Cmd+A are the Edit menu's accelerators, so copying out of a
 * terminal pane and pasting into one silently did nothing. The application menu
 * (Cmd+Q) went missing the same way.
 */
export function appMenuTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  return [
    ...(deps.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        // Opens beside the projects already in the window (the rail lists them all).
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => deps.command('open-project') },
        { label: 'Open File in Session…', accelerator: 'CmdOrCtrl+P', click: () => deps.command('open-file') },
        { label: 'Open Browser Pane', accelerator: 'CmdOrCtrl+Shift+B', click: () => deps.command('open-browser') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => deps.command('open-settings') },
        { label: 'Open Recent', submenu: deps.recent },
        { type: 'separator' },
        // ⌘W closes the focused pane, as in a terminal; the window takes ⌘⇧W.
        { label: 'Close Pane', accelerator: 'CmdOrCtrl+W', click: () => deps.command('close-pane') },
        { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' },
      ],
    },
    // Electron's Edit roles (copy, paste, select all keep their accelerators — see the
    // note above), plus Find for the terminal panes.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => deps.command('find') },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => deps.command('find-next') },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => deps.command('find-prev') },
      ],
    },
    {
      // Accelerators live in the menu, not a keydown listener: a focused terminal pane
      // swallows keystrokes, and the menu both wins over it and shows the shortcut.
      label: 'Session',
      submenu: [
        { label: 'Command…', accelerator: 'CmdOrCtrl+K', click: () => deps.command('command-bar') },
        { label: 'New Session…', accelerator: 'CmdOrCtrl+T', click: () => deps.command('new-agent') },
        { label: 'Jump to Attention', accelerator: 'CmdOrCtrl+Shift+A', click: () => deps.command('jump-attention') },
        { label: 'Open Terminal', accelerator: 'CmdOrCtrl+Shift+T', click: () => deps.command('open-terminal') },
        { type: 'separator' },
        ...JUMP_KEYS.map((n) => ({
          label: `Go to Session ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          click: () => deps.command(`jump-${n}`),
        })),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => deps.command('toggle-sidebar') },
        { label: 'Split Right', accelerator: 'CmdOrCtrl+D', click: () => deps.command('split-right') },
        { label: 'Split Down', accelerator: 'CmdOrCtrl+Shift+D', click: () => deps.command('split-down') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
}
