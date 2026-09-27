import { describe, expect, test } from 'bun:test'
import { xtermLook } from '../src/lib/terminal-look'
import { XTERM_FONT_FAMILY, XTERM_FONT_SIZE, XTERM_THEME } from '../src/ui/tokens'

describe('xtermLook', () => {
  test("nothing imported: exactly the cockpit's pane", () => {
    expect(xtermLook(undefined)).toEqual({
      fontFamily: XTERM_FONT_FAMILY, fontSize: XTERM_FONT_SIZE, theme: { ...XTERM_THEME },
      cursorStyle: 'block', cursorBlink: true, macOptionIsMeta: false,
    })
  })

  test('an imported appearance over it; the family first, the cockpit stack behind', () => {
    const ansi = Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`)
    const look = xtermLook({
      fontFamily: 'JetBrainsMono Nerd Font Mono', fontSize: 12, cursorStyle: 'bar', cursorBlink: false, optionAsMeta: true,
      colors: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorText: '#111111', selection: '#585b70', ansi },
    })
    expect(look.fontFamily).toBe(`"JetBrainsMono Nerd Font Mono", ${XTERM_FONT_FAMILY}`)
    expect(look).toMatchObject({ fontSize: 12, cursorStyle: 'bar', cursorBlink: false, macOptionIsMeta: true })
    expect(look.theme).toMatchObject({ background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#111111', selectionBackground: '#585b70', black: '#000000', brightWhite: '#00000f' })
  })

  test('colors without ANSI keep the cockpit sixteen; no cursor color uses the foreground', () => {
    const look = xtermLook({ colors: { background: '#000000', foreground: '#ffffff' } })
    expect(look.theme.red).toBe(XTERM_THEME.red)
    expect(look.theme.cursor).toBe('#ffffff')
    expect(look.theme.cursorAccent).toBe('#000000')
    // The default theme object itself is never changed.
    expect(XTERM_THEME.background).not.toBe('#000000')
  })
})

describe('the pane follows the window theme', () => {
  test("light theme: the pane's base is light; imported colors still win", async () => {
    const { LIGHT_COLORS, xtermThemeFor } = await import('../src/ui/themes')
    const base = xtermThemeFor({ name: 'light', colors: LIGHT_COLORS, scheme: 'light' })
    const plain = xtermLook(undefined, base)
    expect(plain.theme.background).toBe(LIGHT_COLORS['--cw-surface'])
    expect(plain.theme.foreground).toBe(LIGHT_COLORS['--cw-text'])
    expect(plain.theme.black).toBe('#383a42')
    const imported = xtermLook({ colors: { background: '#000000', foreground: '#ffffff' } }, base)
    expect(imported.theme.background).toBe('#000000')
  })
})
