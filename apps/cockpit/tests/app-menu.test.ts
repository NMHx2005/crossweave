import { describe, expect, test } from 'bun:test'
import { appMenuTemplate } from '../electron/app-menu'

const noop = () => undefined
const build = (platform: NodeJS.Platform) =>
  appMenuTemplate({ platform, openFolder: noop, recent: [{ label: 'No Recent Folders', enabled: false }], command: noop })

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

  test('keeps File > Open Folder and Open Recent', () => {
    const file = build('darwin').find((item) => item.label === 'File')
    const labels = (file?.submenu as Array<{ label?: string }>).map((i) => i.label)
    expect(labels).toContain('Open Folder…')
    expect(labels).toContain('Open Recent')
  })
})

describe('agent shortcuts', () => {
  test('⌘K opens the command bar, ⌘T the agent picker, ⌘⇧A jumps to attention, from the menu', () => {
    const fired: string[] = []
    const menu = appMenuTemplate({ platform: 'darwin', openFolder: noop, recent: [], command: (c) => fired.push(c) })
    const agent = menu.find((m) => m.label === 'Agent')!.submenu as Array<{ label: string; accelerator?: string; click?: () => void }>
    expect(agent.map((i) => i.accelerator)).toEqual(['CmdOrCtrl+K', 'CmdOrCtrl+T', 'CmdOrCtrl+Shift+A', 'CmdOrCtrl+Shift+T'])
    for (const item of agent) item.click?.()
    expect(fired).toEqual(['command-bar', 'new-agent', 'jump-attention', 'open-terminal'])
  })
})
