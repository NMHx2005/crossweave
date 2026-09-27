import type { TerminalAppearance, TerminalColors } from './settings.js';

/**
 * Terminal appearance read from the user's own terminal, as Cursor imports a VS Code
 * setup. Pure: the cockpit's main process finds and reads the files (and resolves an
 * iTerm2 PostScript font name through macOS); these functions only map what was read.
 * Whatever does not map cleanly is left out, so the pane keeps the cockpit's value.
 */

const MIN_SIZE = 8;
const MAX_SIZE = 32;

function clampSize(n: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));
}

/** `#rrggbb` from Ghostty's `#rrggbb` / `rrggbb`; undefined for a named or odd color. */
function hexColor(value: string): string | undefined {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  return m ? `#${(m[1] as string).toLowerCase()}` : undefined;
}

/** Ghostty's `key = value` lines, in order (keys repeat: palette, font-family). */
export function parseGhosttyConfig(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key !== '') out.push([key, value]);
  }
  return out;
}

const last = (entries: Array<[string, string]>, key: string): string | undefined =>
  entries.filter(([k]) => k === key).pop()?.[1];

/** The theme a config names; of `light:X,dark:Y`, the dark one — the cockpit is dark. */
export function ghosttyThemeName(entries: Array<[string, string]>): string | undefined {
  const value = last(entries, 'theme');
  if (value === undefined || value === '') return undefined;
  if (!value.includes(':')) return value;
  const pairs = value.split(',').map((p) => p.split(':').map((s) => s.trim()) as [string, string?]);
  return pairs.find(([mode]) => mode === 'dark')?.[1] ?? pairs[0]?.[1] ?? undefined;
}

/** Colors from the entries in order — a theme's first, then the config's on top. */
function ghosttyColors(entries: Array<[string, string]>): TerminalColors | undefined {
  const named: Record<string, string> = {};
  const palette: Array<string | undefined> = new Array(16).fill(undefined);
  for (const [key, value] of entries) {
    if (key === 'palette') {
      const m = /^(\d{1,3})\s*=\s*(.+)$/.exec(value);
      const index = m ? Number(m[1]) : -1;
      const color = m ? hexColor(m[2] as string) : undefined;
      if (index >= 0 && index < 16 && color) palette[index] = color;
      continue;
    }
    const color = hexColor(value);
    if (color && ['background', 'foreground', 'cursor-color', 'cursor-text', 'selection-background'].includes(key)) named[key] = color;
  }
  if (!named.background || !named.foreground) return undefined;
  const colors: TerminalColors = { background: named.background, foreground: named.foreground };
  if (named['cursor-color']) colors.cursor = named['cursor-color'];
  if (named['cursor-text']) colors.cursorText = named['cursor-text'];
  if (named['selection-background']) colors.selection = named['selection-background'];
  if (palette.every((c) => c !== undefined)) colors.ansi = palette as string[];
  return colors;
}

/** A Ghostty config (and the theme it names, already read) as the cockpit's appearance. */
export function ghosttyAppearance(config: Array<[string, string]>, theme: Array<[string, string]> | undefined): TerminalAppearance {
  const out: TerminalAppearance = {};
  // The first font-family is the primary; later ones are fallbacks xterm cannot use.
  const family = config.find(([k]) => k === 'font-family')?.[1];
  if (family) out.fontFamily = family;
  const size = Number(last(config, 'font-size'));
  if (Number.isFinite(size) && size > 0) out.fontSize = clampSize(size);
  const style = last(config, 'cursor-style');
  if (style === 'block' || style === 'block_hollow') out.cursorStyle = 'block';
  else if (style === 'bar' || style === 'underline') out.cursorStyle = style;
  const blink = last(config, 'cursor-style-blink');
  if (blink === 'true' || blink === 'false') out.cursorBlink = blink === 'true';
  const option = last(config, 'macos-option-as-alt');
  if (option !== undefined) out.optionAsMeta = option === 'true' || option === 'left' || option === 'right';
  const colors = ghosttyColors([...(theme ?? []), ...config]);
  if (colors) out.colors = colors;
  out.importedFrom = 'ghostty';
  return out;
}

/** iTerm2's `Normal Font` value: a PostScript name and a size. */
export function splitItermFont(value: string): { postScriptName: string; size: number } | undefined {
  const m = /^(\S+)\s+(\d+(?:\.\d+)?)$/.exec(value.trim());
  return m ? { postScriptName: m[1] as string, size: clampSize(Number(m[2])) } : undefined;
}

type ItermColor = { 'Red Component'?: unknown; 'Green Component'?: unknown; 'Blue Component'?: unknown };

function itermHex(value: unknown): string | undefined {
  const c = value as ItermColor | null;
  if (c === null || typeof c !== 'object') return undefined;
  const parts = [c['Red Component'], c['Green Component'], c['Blue Component']];
  if (!parts.every((p) => typeof p === 'number' && p >= 0 && p <= 1)) return undefined;
  return `#${parts.map((p) => Math.round((p as number) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The default profile (by `Default Bookmark Guid`, else the first) as the cockpit's
 * appearance. The font comes back as a PostScript name for the caller to resolve to a
 * family (macOS knows; CSS does not).
 */
export function itermAppearance(profiles: unknown[], defaultGuid: string | undefined): { appearance: TerminalAppearance; fontPostScriptName?: string } {
  const list = Array.isArray(profiles) ? profiles.filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object') : [];
  const profile = list.find((p) => p.Guid === defaultGuid) ?? list[0];
  if (profile === undefined) return { appearance: { importedFrom: 'iterm2' } };

  const dark = profile['Use Separate Colors for Light and Dark Mode'] === true;
  const color = (name: string): string | undefined => itermHex((dark ? profile[`${name} (Dark)`] : undefined) ?? profile[name]);

  const out: TerminalAppearance = {};
  let fontPostScriptName: string | undefined;
  const font = typeof profile['Normal Font'] === 'string' ? splitItermFont(profile['Normal Font']) : undefined;
  if (font) {
    fontPostScriptName = font.postScriptName;
    out.fontSize = font.size;
  }
  const cursor = profile['Cursor Type'];
  if (cursor === 0) out.cursorStyle = 'underline';
  else if (cursor === 1) out.cursorStyle = 'bar';
  else if (cursor === 2) out.cursorStyle = 'block';
  if (typeof profile['Blinking Cursor'] === 'boolean') out.cursorBlink = profile['Blinking Cursor'];
  // 0 Normal, 1 Meta, 2 Esc+: either of the last two is what xterm calls Option-as-Meta.
  const option = profile['Option Key Sends'];
  if (typeof option === 'number') out.optionAsMeta = option === 1 || option === 2;

  const background = color('Background Color');
  const foreground = color('Foreground Color');
  if (background && foreground) {
    const colors: TerminalColors = { background, foreground };
    const cursorColor = color('Cursor Color');
    const cursorText = color('Cursor Text Color');
    const selection = color('Selection Color');
    if (cursorColor) colors.cursor = cursorColor;
    if (cursorText) colors.cursorText = cursorText;
    if (selection) colors.selection = selection;
    const ansi = Array.from({ length: 16 }, (_, i) => color(`Ansi ${i} Color`));
    if (ansi.every((c) => c !== undefined)) colors.ansi = ansi as string[];
    out.colors = colors;
  }
  out.importedFrom = 'iterm2';
  return fontPostScriptName === undefined ? { appearance: out } : { appearance: out, fontPostScriptName };
}
