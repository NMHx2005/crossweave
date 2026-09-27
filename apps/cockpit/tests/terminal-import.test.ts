import { describe, expect, test } from 'bun:test'
import { FONT_FAMILY_SCRIPT, ghosttyConfigPaths, ghosttyThemePaths, importSources, importTerminal, type ImportDeps } from '../electron/terminal-import'

const HOME = '/Users/me'

function deps(files: Record<string, string>, run: ImportDeps['run'] = async () => undefined): ImportDeps & { calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = []
  return {
    home: HOME,
    readFile: (p) => files[p],
    run: async (command, args) => { calls.push([command, args]); return run(command, args) },
    calls,
  }
}

const fontOk = (family: string): ImportDeps['run'] => async (command) => (command === 'osascript' ? `${family}\n` : undefined)

describe('ghostty paths', () => {
  test('config files in the order Ghostty applies them', () => {
    expect(ghosttyConfigPaths(HOME)).toEqual([
      '/Users/me/.config/ghostty/config',
      '/Users/me/.config/ghostty/config.ghostty',
      '/Users/me/Library/Application Support/com.mitchellh.ghostty/config',
      '/Users/me/Library/Application Support/com.mitchellh.ghostty/config.ghostty',
    ])
    expect(ghosttyConfigPaths(HOME, '/x')[0]).toBe('/x/ghostty/config')
  })

  test('a theme name never walks out of the themes directories', () => {
    expect(ghosttyThemePaths('Nord', HOME)).toEqual([
      '/Users/me/.config/ghostty/themes/Nord',
      '/Applications/Ghostty.app/Contents/Resources/ghostty/themes/Nord',
    ])
    expect(ghosttyThemePaths('../../etc/passwd', HOME)).toEqual([])
    expect(ghosttyThemePaths('..', HOME)).toEqual([])
    expect(ghosttyThemePaths('/Users/me/my-theme', HOME)).toEqual(['/Users/me/my-theme'])
  })
})

describe('importSources', () => {
  test('which terminals have settings on this machine', () => {
    expect(importSources(deps({ '/Users/me/.config/ghostty/config': 'font-size = 12' }))).toEqual({ ghostty: true, iterm2: false })
    expect(importSources(deps({ '/Users/me/Library/Preferences/com.googlecode.iterm2.plist': 'bplist' }))).toEqual({ ghostty: false, iterm2: true })
  })
})

describe('importTerminal — Ghostty', () => {
  const theme = [
    ...Array.from({ length: 16 }, (_, i) => `palette = ${i}=#0000${i.toString(16).padStart(2, '0')}`),
    'background = #1e1e2e', 'foreground = #cdd6f4',
  ].join('\n')

  test('config + theme, with the font resolved by macOS (the name passed as an argument)', async () => {
    const d = deps({
      '/Users/me/.config/ghostty/config': 'theme = Catppuccin Mocha\nfont-family = "JetBrainsMono Nerd Font Mono"\nfont-size = 12\nmacos-option-as-alt = left',
      '/Applications/Ghostty.app/Contents/Resources/ghostty/themes/Catppuccin Mocha': theme,
    }, fontOk('JetBrainsMono Nerd Font Mono'))
    const r = await importTerminal('ghostty', d)
    expect(r).toMatchObject({ ok: true, notes: [], appearance: { fontFamily: 'JetBrainsMono Nerd Font Mono', fontSize: 12, optionAsMeta: true, importedFrom: 'ghostty', colors: { background: '#1e1e2e' } } })
    expect(d.calls).toEqual([['osascript', ['-l', 'JavaScript', '-e', FONT_FAMILY_SCRIPT, 'JetBrainsMono Nerd Font Mono']]])
  })

  test('a missing theme or font is said, and left out', async () => {
    const r = await importTerminal('ghostty', deps({ '/Users/me/.config/ghostty/config': 'theme = Nope\nfont-family = Missing Font\nfont-size = 14' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.appearance).toEqual({ fontSize: 14, importedFrom: 'ghostty' })
    expect(r.notes).toEqual([
      'Theme "Nope" was not found; only colors set in the config itself were used',
      'Font "Missing Font" is not installed; the cockpit\'s font is kept',
    ])
  })

  test('no config at all', async () => {
    expect(await importTerminal('ghostty', deps({}))).toEqual({ ok: false, reason: 'No Ghostty config found (~/.config/ghostty/config)' })
  })
})

describe('importTerminal — iTerm2', () => {
  const rgb = (r: number, g: number, b: number) => ({ 'Red Component': r / 255, 'Green Component': g / 255, 'Blue Component': b / 255 })
  const profiles = JSON.stringify([{
    Guid: 'G-1', 'Normal Font': 'JetBrainsMonoNFM-Regular 12', 'Option Key Sends': 2,
    'Background Color': rgb(30, 30, 46), 'Foreground Color': rgb(205, 214, 244),
  }])

  test('the default profile through plutil, the PostScript font resolved to its family', async () => {
    const d = deps({}, async (command, args) => {
      if (command === 'plutil' && args[1] === 'New Bookmarks') return profiles
      if (command === 'plutil' && args[1] === 'Default Bookmark Guid') return 'G-1\n'
      if (command === 'osascript') return 'JetBrainsMono Nerd Font Mono\n'
      return undefined
    })
    const r = await importTerminal('iterm2', d)
    expect(r).toMatchObject({ ok: true, appearance: { fontFamily: 'JetBrainsMono Nerd Font Mono', fontSize: 12, optionAsMeta: true, colors: { background: '#1e1e2e', foreground: '#cdd6f4' } } })
    expect(d.calls[0]).toEqual(['plutil', ['-extract', 'New Bookmarks', 'json', '-o', '-', '/Users/me/Library/Preferences/com.googlecode.iterm2.plist']])
    expect(d.calls.at(-1)).toEqual(['osascript', ['-l', 'JavaScript', '-e', FONT_FAMILY_SCRIPT, 'JetBrainsMonoNFM-Regular']])
  })

  test('no plist, or one that is not JSON', async () => {
    expect(await importTerminal('iterm2', deps({}))).toEqual({ ok: false, reason: 'No iTerm2 profiles found' })
    expect(await importTerminal('iterm2', deps({}, async () => 'not json'))).toEqual({ ok: false, reason: 'Could not read iTerm2 profiles' })
  })
})
