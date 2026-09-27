import { describe, expect, test } from 'bun:test'
import { FONT_LIST_SCRIPT, listFonts, parseFontList } from '../electron/fonts'

describe('parseFontList', () => {
  test('fixed-pitch as macOS says, or as the name says; hidden and unstorable names left out; sorted', () => {
    expect(parseFontList([
      'P Inter',
      'M JetBrains Mono',
      'P JetBrainsMono Nerd Font Mono',
      'P Fira Code',
      'P .AppleSystemUIFont',
      "P Bradley Hand's Font",
      'P avenir',
      'garbage line',
      'P Inter',
    ].join('\n'))).toEqual([
      { family: 'avenir', mono: false },
      { family: 'Fira Code', mono: true },
      { family: 'Inter', mono: false },
      { family: 'JetBrains Mono', mono: true },
      { family: 'JetBrainsMono Nerd Font Mono', mono: true },
    ])
    expect(parseFontList('')).toEqual([])
  })
})

describe('listFonts', () => {
  test('asks macOS once, with a fixed script', async () => {
    const calls: Array<[string, string[]]> = []
    const run = async (command: string, args: string[]) => { calls.push([command, args]); return 'M Menlo\nP Inter' }
    const first = await listFonts(run)
    const second = await listFonts(run)
    expect(first).toEqual([{ family: 'Inter', mono: false }, { family: 'Menlo', mono: true }])
    expect(second).toBe(first)
    expect(calls).toEqual([['osascript', ['-l', 'JavaScript', '-e', FONT_LIST_SCRIPT]]])
  })
})
