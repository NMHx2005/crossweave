import type { MenuItemConstructorOptions } from 'electron'
import type { RecentMenuItem } from './recent-menu'
import { COMMANDS, effectiveKeys, isAccelerator, type MenuName } from '../src/lib/keymap'

/** A command id from the keymap (src/lib/keymap.ts). */
export type CockpitCommand = string

export interface AppMenuDeps {
  platform: NodeJS.Platform
  recent: RecentMenuItem[]
  /** Settings → Keyboard: the user's shortcuts over the defaults (null unbinds). */
  keybindings?: Readonly<Record<string, string | null>>
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
 *
 * Accelerators live in the menu, not a keydown listener: a focused terminal pane
 * swallows keystrokes, and the menu both wins over it and shows the shortcut.
 */
export function appMenuTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  const keys = effectiveKeys(deps.keybindings)
  const item = (id: string): MenuItemConstructorOptions => {
    const spec = COMMANDS.find((c) => c.id === id)
    if (!spec) throw new Error(`unknown command ${id}`)
    const key = keys[id]
    // A shortcut Electron would reject is left off rather than breaking the menu.
    return { label: spec.label, ...(key && isAccelerator(key) ? { accelerator: key } : {}), click: () => deps.command(id) }
  }
  const of = (menu: MenuName): string[] => COMMANDS.filter((c) => c.menu === menu).map((c) => c.id)
  const sep: MenuItemConstructorOptions = { type: 'separator' }

  return [
    ...(deps.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        // Opens beside the projects already in the window (the rail lists them all).
        item('open-project'), item('open-file'), item('open-browser'),
        sep,
        item('open-settings'),
        { label: 'Open Recent', submenu: deps.recent },
        sep,
        // ⌘W closes the focused pane, as in a terminal; the window takes ⌘⇧W.
        item('close-pane'),
        { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' },
      ],
    },
    // Electron's Edit roles (copy, paste, select all keep their accelerators — see the
    // note above), plus Find for the terminal panes.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, sep,
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        sep,
        ...of('Edit').map(item),
      ],
    },
    {
      label: 'Session',
      submenu: [
        ...of('Session').filter((id) => !/^jump-\d$/.test(id)).map(item),
        sep,
        ...of('Session').filter((id) => /^jump-\d$/.test(id)).map(item),
      ],
    },
    {
      label: 'View',
      submenu: [
        ...of('View').map(item),
        sep,
        { role: 'reload' },
        { role: 'toggleDevTools' },
        sep,
        { role: 'togglefullscreen' },
      ],
    },
    {
      // tmux's pane keys, as a Mac menu: split, zoom, move focus, arrange.
      label: 'Pane',
      submenu: [
        item('split-right'), item('split-down'), sep,
        item('zoom-pane'), item('focus-left'), item('focus-right'), item('focus-up'), item('focus-down'), sep,
        item('equalize-panes'), item('layout-even-horizontal'), item('layout-even-vertical'), item('layout-main-left'), item('layout-tiled'), sep,
        item('swap-next'), item('pane-to-tab'),
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: of('Help').map(item) },
  ]
}
