import { describe, expect, it } from 'bun:test';
import {
  ghosttyAppearance,
  ghosttyThemeName,
  itermAppearance,
  parseGhosttyConfig,
  splitItermFont,
} from '../../src/core/terminal-import.js';

// The formats as they are on disk: Ghostty's `key = value` config and theme files,
// and iTerm2's profiles as `plutil -extract "New Bookmarks" json` prints them.
const THEME = [
  ...Array.from({ length: 16 }, (_, i) => `palette = ${i}=#${(i * 16).toString(16).padStart(2, '0')}1020`),
  'background = #1e1e2e',
  'foreground = #cdd6f4',
  'cursor-color = #f5e0dc',
  'cursor-text = #1e1e2e',
  'selection-background = #585b70',
  'selection-foreground = #cdd6f4',
].join('\n');

const CONFIG = [
  '# my ghostty',
  'theme = Catppuccin Mocha',
  'font-family = "JetBrainsMono Nerd Font Mono"',
  'font-family = Symbols Nerd Font',
  'font-size = 12',
  'macos-option-as-alt = left',
  'font-thicken = true',
  '',
  'palette = 1=#ff0000',
].join('\n');

describe('parseGhosttyConfig', () => {
  it('reads key = value lines, unquoting values and skipping comments and blanks', () => {
    expect(parseGhosttyConfig(CONFIG)).toEqual([
      ['theme', 'Catppuccin Mocha'],
      ['font-family', 'JetBrainsMono Nerd Font Mono'],
      ['font-family', 'Symbols Nerd Font'],
      ['font-size', '12'],
      ['macos-option-as-alt', 'left'],
      ['font-thicken', 'true'],
      ['palette', '1=#ff0000'],
    ]);
  });
});

describe('ghosttyThemeName', () => {
  it('the theme named, or the dark one of a light/dark pair (the cockpit is dark)', () => {
    expect(ghosttyThemeName(parseGhosttyConfig('theme = Nord'))).toBe('Nord');
    expect(ghosttyThemeName(parseGhosttyConfig('theme = light:Catppuccin Latte,dark:Catppuccin Mocha'))).toBe('Catppuccin Mocha');
    expect(ghosttyThemeName(parseGhosttyConfig('font-size = 12'))).toBeUndefined();
  });
});

describe('ghosttyAppearance', () => {
  it('font, size, Option key, and the theme\'s colors with the config\'s own on top', () => {
    const a = ghosttyAppearance(parseGhosttyConfig(CONFIG), parseGhosttyConfig(THEME));
    expect(a.fontFamily).toBe('JetBrainsMono Nerd Font Mono');
    expect(a.fontSize).toBe(12);
    expect(a.optionAsMeta).toBe(true);
    expect(a.importedFrom).toBe('ghostty');
    expect(a.colors).toMatchObject({ background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorText: '#1e1e2e', selection: '#585b70' });
    expect(a.colors?.ansi).toHaveLength(16);
    // The config's palette line overrides the theme's.
    expect(a.colors?.ansi?.[1]).toBe('#ff0000');
    expect(a.colors?.ansi?.[2]).toBe('#201020');
  });

  it('cursor style and blink; no theme and no colors means no colors', () => {
    const a = ghosttyAppearance(parseGhosttyConfig('cursor-style = bar\ncursor-style-blink = false\nmacos-option-as-alt = false'), undefined);
    expect(a).toEqual({ cursorStyle: 'bar', cursorBlink: false, optionAsMeta: false, importedFrom: 'ghostty' });
  });

  it('an incomplete palette is not imported (the pane keeps its own ANSI colors)', () => {
    const a = ghosttyAppearance(parseGhosttyConfig('background = 101010\nforeground = #eeeeee\npalette = 0=#000000'), undefined);
    expect(a.colors).toEqual({ background: '#101010', foreground: '#eeeeee' });
  });

  it('a size out of range is clamped; a named color it cannot read is skipped', () => {
    const a = ghosttyAppearance(parseGhosttyConfig('font-size = 40\nbackground = black\nforeground = #ffffff'), undefined);
    expect(a.fontSize).toBe(32);
    expect(a.colors).toBeUndefined();
  });
});

const rgb = (r: number, g: number, b: number) => ({ 'Red Component': r / 255, 'Green Component': g / 255, 'Blue Component': b / 255, 'Alpha Component': 1, 'Color Space': 'sRGB' });
const profile = (over: Record<string, unknown> = {}) => ({
  Name: 'Default',
  Guid: 'G-1',
  'Normal Font': 'JetBrainsMonoNFM-Regular 12',
  'Blinking Cursor': false,
  'Option Key Sends': 2,
  'Background Color': rgb(30, 30, 46),
  'Foreground Color': rgb(205, 214, 244),
  'Cursor Color': rgb(245, 224, 220),
  'Cursor Text Color': rgb(30, 30, 46),
  'Selection Color': rgb(88, 91, 112),
  ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`Ansi ${i} Color`, rgb(i * 10, i * 5, i)])),
  ...over,
});

describe('splitItermFont', () => {
  it('PostScript name and size', () => {
    expect(splitItermFont('JetBrainsMonoNFM-Regular 12')).toEqual({ postScriptName: 'JetBrainsMonoNFM-Regular', size: 12 });
    expect(splitItermFont('Menlo-Regular 13.5')).toEqual({ postScriptName: 'Menlo-Regular', size: 14 });
    expect(splitItermFont('garbage')).toBeUndefined();
  });
});

describe('itermAppearance', () => {
  it('the default profile\'s colors, cursor, Option key and font', () => {
    const r = itermAppearance([profile({ Guid: 'other', 'Background Color': rgb(0, 0, 0) }), profile()], 'G-1');
    expect(r.fontPostScriptName).toBe('JetBrainsMonoNFM-Regular');
    expect(r.appearance).toMatchObject({
      fontSize: 12, cursorBlink: false, optionAsMeta: true, importedFrom: 'iterm2',
      colors: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorText: '#1e1e2e', selection: '#585b70' },
    });
    expect(r.appearance.colors?.ansi?.[15]).toBe('#964b0f');
  });

  it('the first profile when the default is not found; cursor types map to xterm\'s', () => {
    expect(itermAppearance([profile({ 'Cursor Type': 0 })], 'missing').appearance.cursorStyle).toBe('underline');
    expect(itermAppearance([profile({ 'Cursor Type': 1 })], undefined).appearance.cursorStyle).toBe('bar');
    expect(itermAppearance([profile({ 'Cursor Type': 2 })], undefined).appearance.cursorStyle).toBe('block');
  });

  it('the dark variants when the profile keeps separate light and dark colors', () => {
    const r = itermAppearance([profile({ 'Use Separate Colors for Light and Dark Mode': true, 'Background Color (Dark)': rgb(1, 2, 3) })], 'G-1');
    expect(r.appearance.colors?.background).toBe('#010203');
  });

  it('Option key sending Normal is not Meta; no profiles means nothing', () => {
    expect(itermAppearance([profile({ 'Option Key Sends': 0 })], 'G-1').appearance.optionAsMeta).toBe(false);
    expect(itermAppearance([], undefined).appearance).toEqual({ importedFrom: 'iterm2' });
    expect(itermAppearance('nope' as unknown as unknown[], undefined).appearance).toEqual({ importedFrom: 'iterm2' });
  });
});
