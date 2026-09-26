import type { MenuItemConstructorOptions } from 'electron'
import type { RecentMenuItem } from './recent-menu'

export interface AppMenuDeps {
  platform: NodeJS.Platform
  openFolder(): void
  recent: RecentMenuItem[]
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
        { label: 'Open Recent', submenu: deps.recent },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
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
