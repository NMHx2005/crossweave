import { describe, expect, test } from 'bun:test'
import { appMenuTemplate } from '../electron/app-menu'

const noop = () => undefined
const build = (platform: NodeJS.Platform) =>
  appMenuTemplate({ platform, recent: [{ label: 'No Recent Folders', enabled: false }], command: noop })

describe('appMenuTemplate', () => {
  // Replacing Electron's default menu with File/View/Window dropped Edit, and with it
  // Cmd+C / Cmd+V / Cmd+A: copying from a terminal pane and pasting into it both
  // silently did nothing on macOS, where those shortcuts live in the menu.
  test('has an Edit menu, so copy, paste and select-all have their shortcuts', () => {
    const roles = build('darwin').map((item) => item.role ?? item.label)
    expect(roles).toContain('editMenu')
  })

  // The first macOS menu is the application menu (About, Hide, Quit ⌘Q); File was
  // standing in that slot, so Cmd+Q went missing too.
  test('starts with the application menu on macOS only', () => {
    expect(build('darwin')[0]?.role).toBe('appMenu')
    expect(build('linux')[0]?.label).toBe('File')
  })

  test('keeps File > Open Project and Open Recent', () => {
    const file = build('darwin').find((item) => item.label === 'File')
    const labels = (file?.submenu as Array<{ label?: string }>).map((i) => i.label)
    expect(labels).toContain('Open Project…')
    expect(labels).toContain('Open Recent')
  })

  // Deck's pane keys: the pane has no title bar left to click on.
  test('split and close the focused pane, and hide the sidebar, from the keyboard', () => {
    const fired: string[] = []
    const menu = appMenuTemplate({ platform: 'darwin', recent: [], command: (c) => fired.push(c) })
    const items = menu.flatMap((m) => (Array.isArray(m.submenu) ? m.submenu : [])) as Array<{ accelerator?: string; click?: () => void }>
    for (const key of ['CmdOrCtrl+D', 'CmdOrCtrl+Shift+D', 'CmdOrCtrl+W', 'CmdOrCtrl+\\']) {
      items.find((i) => i.accelerator === key)?.click?.()
    }
    expect(fired).toEqual(['split-right', 'split-down', 'close-pane', 'toggle-sidebar'])
  })
})

describe('agent shortcuts', () => {
  test('⌘K opens the command bar, ⌘T the agent picker, ⌘⇧A jumps to attention, from the menu', () => {
    const fired: string[] = []
    const menu = appMenuTemplate({ platform: 'darwin', recent: [], command: (c) => fired.push(c) })
    const agent = (menu.find((m) => m.label === 'Session')!.submenu as Array<{ label: string; accelerator?: string; click?: () => void }>).slice(0, 4)
    expect(agent.map((i) => i.accelerator)).toEqual(['CmdOrCtrl+K', 'CmdOrCtrl+T', 'CmdOrCtrl+Shift+A', 'CmdOrCtrl+Shift+T'])
    for (const item of agent) item.click?.()
    expect(fired).toEqual(['command-bar', 'new-agent', 'jump-attention', 'open-terminal'])
  })

  test('⌘1…⌘9 jump to the Nth session', () => {
    const fired: string[] = []
    const menu = appMenuTemplate({ platform: 'darwin', recent: [], command: (c) => fired.push(c) })
    const items = menu.find((m) => m.label === 'Session')!.submenu as Array<{ accelerator?: string; click?: () => void }>
    for (const n of [1, 5, 9]) items.find((i) => i.accelerator === `CmdOrCtrl+${n}`)?.click?.()
    expect(fired).toEqual(['jump-1', 'jump-5', 'jump-9'])
  })
})
