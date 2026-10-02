/**
 * Every command a shortcut can run: its menu, its label and its default accelerator
 * (Electron's syntax). The menu is built from this list with the user's overrides on
 * top, and Settings → Keyboard and Help → Keyboard Shortcuts show the same list — one
 * source, so a shortcut can never be listed in one place and bound differently in
 * another.
 */
export type MenuName = 'File' | 'Edit' | 'Session' | 'View' | 'Pane' | 'Help'

/** `menu: null` is a command with no menu item: run by a shortcut, the command bar or the key-table. */
export type CommandSpec = { id: string; menu: MenuName | null; label: string; key: string | null }

const JUMPS: CommandSpec[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
  id: `jump-${n}`, menu: 'Session', label: `Go to Session ${n}`, key: `CmdOrCtrl+${n}`,
}))

export const COMMANDS: readonly CommandSpec[] = [
  { id: 'open-project', menu: 'File', label: 'Open Project…', key: 'CmdOrCtrl+O' },
  { id: 'open-file', menu: 'File', label: 'Open File in Session…', key: 'CmdOrCtrl+P' },
  { id: 'open-browser', menu: 'File', label: 'Open Browser Pane', key: 'CmdOrCtrl+Shift+B' }, // gitleaks:allow
  { id: 'open-settings', menu: 'File', label: 'Settings…', key: 'CmdOrCtrl+,' },
  { id: 'close-pane', menu: 'File', label: 'Close Pane', key: 'CmdOrCtrl+W' },
  { id: 'find', menu: 'Edit', label: 'Find…', key: 'CmdOrCtrl+F' },
  { id: 'find-next', menu: 'Edit', label: 'Find Next', key: 'CmdOrCtrl+G' },
  { id: 'find-prev', menu: 'Edit', label: 'Find Previous', key: 'CmdOrCtrl+Shift+G' }, // gitleaks:allow
  { id: 'command-bar', menu: 'Session', label: 'Command…', key: 'CmdOrCtrl+K' },
  { id: 'new-agent', menu: 'Session', label: 'New Session…', key: 'CmdOrCtrl+T' },
  { id: 'jump-attention', menu: 'Session', label: 'Jump to Attention', key: 'CmdOrCtrl+Shift+A' },
  { id: 'open-terminal', menu: 'Session', label: 'Open Terminal', key: 'CmdOrCtrl+Shift+T' },
  { id: 'prompt-composer', menu: 'Session', label: 'Prompt…', key: 'CmdOrCtrl+Shift+P' },
  { id: 'show-responses', menu: 'Session', label: 'Responses…', key: 'CmdOrCtrl+Shift+R' },
  { id: 'next-tab', menu: 'Session', label: 'Next Tab', key: 'CmdOrCtrl+Shift+]' },
  { id: 'prev-tab', menu: 'Session', label: 'Previous Tab', key: 'CmdOrCtrl+Shift+[' },
  ...JUMPS,
  { id: 'toggle-sidebar', menu: 'View', label: 'Toggle Sidebar', key: 'CmdOrCtrl+\\' },
  { id: 'split-right', menu: 'Pane', label: 'Split Right', key: 'CmdOrCtrl+D' },
  { id: 'split-down', menu: 'Pane', label: 'Split Down', key: 'CmdOrCtrl+Shift+D' }, // gitleaks:allow
  { id: 'zoom-pane', menu: 'Pane', label: 'Zoom Pane', key: 'CmdOrCtrl+Shift+Enter' }, // gitleaks:allow
  { id: 'focus-left', menu: 'Pane', label: 'Focus Pane Left', key: 'CmdOrCtrl+Alt+Left' },
  { id: 'focus-right', menu: 'Pane', label: 'Focus Pane Right', key: 'CmdOrCtrl+Alt+Right' },
  { id: 'focus-up', menu: 'Pane', label: 'Focus Pane Above', key: 'CmdOrCtrl+Alt+Up' },
  { id: 'focus-down', menu: 'Pane', label: 'Focus Pane Below', key: 'CmdOrCtrl+Alt+Down' }, // gitleaks:allow
  { id: 'equalize-panes', menu: 'Pane', label: 'Equalize Pane Sizes', key: 'CmdOrCtrl+Alt+=' },
  { id: 'layout-even-horizontal', menu: 'Pane', label: 'Layout: Side by Side', key: null },
  { id: 'layout-even-vertical', menu: 'Pane', label: 'Layout: Stacked', key: null },
  { id: 'layout-main-left', menu: 'Pane', label: 'Layout: Main Left', key: null },
  { id: 'layout-tiled', menu: 'Pane', label: 'Layout: Tiled', key: null },
  { id: 'pane-to-tab', menu: 'Pane', label: 'Move Pane to New Tab', key: null },
  { id: 'swap-next', menu: 'Pane', label: 'Swap with Next Pane', key: null },
  { id: 'sync-panes', menu: 'Pane', label: 'Synchronize Panes', key: null },
  { id: 'copy-mode', menu: 'Pane', label: 'Enter Copy Mode', key: null },
  // No menu item: reachable from a shortcut the user binds, the command bar, or (later) the key-table.
  { id: 'cycle-layout', menu: null, label: 'Cycle Pane Layout', key: null },
  { id: 'show-session-history', menu: 'Session', label: 'Session History…', key: 'CmdOrCtrl+Shift+H' },
  { id: 'show-shortcuts', menu: 'Help', label: 'Keyboard Shortcuts', key: 'CmdOrCtrl+/' },
  // The key-table's prefix (tmux's Ctrl-b). Not a command that runs: the window listens for it in a
  // terminal pane, then takes one more key. Unbind it to switch the key-table off.
  { id: 'prefix', menu: null, label: 'Prefix Key (key-table)', key: 'Ctrl+A' },
]

const IDS = new Set(COMMANDS.map((c) => c.id))

export function isCommandId(id: string): boolean {
  return IDS.has(id)
}

const MODIFIERS = new Set(['CmdOrCtrl', 'CommandOrControl', 'Cmd', 'Command', 'Ctrl', 'Control', 'Alt', 'Option', 'Shift', 'Super', 'Meta'])
const NAMED_KEYS = new Set([
  'Plus', 'Space', 'Tab', 'Backspace', 'Delete', 'Enter', 'Return', 'Escape', 'Esc',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Insert',
])

/**
 * Whether `accelerator` is one Electron accepts and a person can press: modifiers,
 * then one key. Anything but a function key needs a modifier — a bare letter would
 * steal typing from every terminal.
 */
export function isAccelerator(accelerator: string): boolean {
  const parts = accelerator.split('+')
  // A trailing "+" key is written "Plus"; an empty part means a malformed string.
  if (parts.some((p) => p === '')) return false
  const key = parts.at(-1) as string
  const mods = parts.slice(0, -1)
  if (mods.some((m) => !MODIFIERS.has(m)) || new Set(mods).size !== mods.length) return false
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
  const valid = fn || NAMED_KEYS.has(key) || /^[A-Z0-9]$/.test(key) || /^[,./;'[\]\\\-=`]$/.test(key)
  return valid && (fn || mods.length > 0)
}

/** One spelling per chord, so `Cmd+Shift+D` and `Shift+CmdOrCtrl+D` compare equal. */
export function normalizeAccelerator(accelerator: string): string {
  const parts = accelerator.split('+')
  const key = parts.at(-1) as string
  const alias: Record<string, string> = {
    CommandOrControl: 'CmdOrCtrl', Cmd: 'CmdOrCtrl', Command: 'CmdOrCtrl', Meta: 'CmdOrCtrl', Super: 'CmdOrCtrl',
    Control: 'Ctrl', Option: 'Alt',
  }
  const order = ['CmdOrCtrl', 'Ctrl', 'Alt', 'Shift']
  const mods = [...new Set(parts.slice(0, -1).map((m) => alias[m] ?? m))].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const keyName = key === 'Return' ? 'Enter' : key === 'Esc' ? 'Escape' : key
  return [...mods, keyName].join('+')
}

/** The shortcut each command ends up with: defaults, then the user's (null unbinds). */
export function effectiveKeys(overrides: Readonly<Record<string, string | null>> | undefined): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const c of COMMANDS) {
    const o = overrides?.[c.id]
    out[c.id] = o === undefined ? c.key : o
  }
  return out
}

/** Commands bound to the same chord — each would shadow the other in the menu. */
export function keyConflicts(keys: Readonly<Record<string, string | null>>): Array<{ key: string; ids: string[] }> {
  const byKey = new Map<string, string[]>()
  for (const [id, key] of Object.entries(keys)) {
    if (!key) continue
    const k = key.startsWith('prefix:') ? key : normalizeAccelerator(key)
    byKey.set(k, [...(byKey.get(k) ?? []), id])
  }
  return [...byKey.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids }))
}

const GLYPHS: Record<string, string> = {
  CmdOrCtrl: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧',
  Enter: '↩', Escape: '⎋', Tab: '⇥', Backspace: '⌫', Delete: '⌦', Space: 'Space',
  Up: '↑', Down: '↓', Left: '←', Right: '→', Plus: '+', PageUp: '⇞', PageDown: '⇟', Home: '↖', End: '↘',
}

/** `CmdOrCtrl+Shift+D` as a Mac shows it: ⌘⇧D. */
export function formatAccelerator(accelerator: string | null): string {
  if (!accelerator) return ''
  return normalizeAccelerator(accelerator).split('+').map((p) => GLYPHS[p] ?? p).join('')
}

type KeyLike = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/**
 * The accelerator a key press spells, for the Settings recorder; null while only
 * modifiers are down or for a key Electron cannot bind. Uses the physical key (`code`)
 * so Option and Shift do not turn "D" into "∂" or "Ð".
 */
export function acceleratorFromKey(e: KeyLike): string | null {
  let key: string | undefined
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3)
  else if (/^Digit[0-9]$/.test(c)) key = c.slice(5)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) key = c
  else {
    const named: Record<string, string> = {
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Enter', Escape: 'Escape',
      Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
      BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
    }
    key = named[c]
  }
  if (key === undefined) return null
  const mods = [e.metaKey ? 'CmdOrCtrl' : '', e.ctrlKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean)
  const accel = [...mods, key].join('+')
  return isAccelerator(accel) ? accel : null
}

export type ShortcutCapture =
  | { kind: 'cancel' }
  | { kind: 'ignore' }
  | { kind: 'await' }
  | { kind: 'record'; key: string }

/**
 * One keydown while the capture dialog is open. Escape (bare) cancels; the prefix
 * chord starts a key-table sequence (`prefix:<key>`, the next press completes it);
 * anything that spells no accelerator is ignored.
 */
export function shortcutFromKey(
  e: KeyLike,
  opts: {
    /** The command being recorded (the prefix itself records no sequence). */
    commandId: string
    prefix: string | null
    awaiting: boolean
    tableKeyOf?: (e: KeyLike) => string | null
  },
): ShortcutCapture {
  if (e.code === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return { kind: 'cancel' }
  if (opts.awaiting) {
    const k = opts.tableKeyOf?.(e) ?? null
    return k === null ? { kind: 'ignore' } : { kind: 'record', key: `prefix:${k}` }
  }
  const accel = acceleratorFromKey(e)
  if (accel === null) return { kind: 'ignore' }
  if (opts.commandId !== 'prefix' && opts.prefix !== null && normalizeAccelerator(accel) === normalizeAccelerator(opts.prefix)) {
    return { kind: 'await' }
  }
  return { kind: 'record', key: accel }
}

/**
 * A key press against an accelerator. Compares the chord the press spells (from the physical
 * key, so Option does not turn D into ∂) with the accelerator normalised; a bare modifier
 * press spells nothing and never matches. macOS only: `CmdOrCtrl` is ⌘.
 */
export function keyMatchesAccelerator(e: KeyLike, accelerator: string): boolean {
  const spelled = acceleratorFromKey(e)
  return spelled !== null && normalizeAccelerator(spelled) === normalizeAccelerator(accelerator)
}

/**
 * The shortcuts to listen for in the window itself: commands with no menu item, so no menu
 * accelerator carries them. Everything with a menu item keeps its accelerator in the menu,
 * which wins over a focused terminal pane.
 */
export function menuLessBindings(keys: Readonly<Record<string, string | null>>): Array<{ id: string; accelerator: string }> {
  return COMMANDS.filter((c) => c.menu === null && c.id !== 'prefix' && keys[c.id] && isAccelerator(keys[c.id] as string))
    .map((c) => ({ id: c.id, accelerator: keys[c.id] as string }))
}

/** A binding as it is shown: an accelerator as ⌘⇧D, a key-table binding as the prefix then its key. */
export function formatBinding(value: string | null, prefix: string | null): string {
  if (!value) return ''
  if (!value.startsWith('prefix:')) return formatAccelerator(value)
  const key = value.slice('prefix:'.length)
  return `${prefix ? formatAccelerator(prefix) : 'prefix'} ${GLYPHS[key] ?? key}`
}
