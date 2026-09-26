import type { MenuItemConstructorOptions } from 'electron'
import type { RecentMenuItem } from './recent-menu'

export type CockpitCommand = 'command-bar' | 'new-agent' | 'jump-attention' | 'open-terminal' | 'open-file' | 'open-browser' | 'open-settings'

export interface AppMenuDeps {
  platform: NodeJS.Platform
  openFolder(): void
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
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => deps.openFolder() },
        { label: 'Open File in Session…', accelerator: 'CmdOrCtrl+P', click: () => deps.command('open-file') },
        { label: 'Open Browser Pane', accelerator: 'CmdOrCtrl+Shift+B', click: () => deps.command('open-browser') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => deps.command('open-settings') },
        { label: 'Open Recent', submenu: deps.recent },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      // Accelerators live in the menu, not a keydown listener: a focused terminal pane
      // swallows keystrokes, and the menu both wins over it and shows the shortcut.
      label: 'Agent',
      submenu: [
        { label: 'Command…', accelerator: 'CmdOrCtrl+K', click: () => deps.command('command-bar') },
        { label: 'New Agent…', accelerator: 'CmdOrCtrl+T', click: () => deps.command('new-agent') },
        { label: 'Jump to Attention', accelerator: 'CmdOrCtrl+Shift+A', click: () => deps.command('jump-attention') },
        { label: 'Open Terminal', accelerator: 'CmdOrCtrl+Shift+T', click: () => deps.command('open-terminal') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
}
