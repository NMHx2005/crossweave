import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { formatEnvLines, launcherIdFor, parseEnvLines } from '../lib/launchers'
import { AgentMark, AppearanceIcon, BackIcon, BellIcon, CodeIcon, DashboardIcon, KeyboardIcon, LauncherIcon, PenIcon, PresetsIcon, TerminalIcon, UsageIcon } from './icons'
import { Banner, Segmented, SettingRow, SettingsGroup, Switch } from './SettingsKit'
import { SettingsDashboard } from './SettingsDashboard'
import type { InterfaceAppearance, ModelPrice, PersistenceSettings, TerminalAppearance, UsageSettings, PromptSettings, SessionPreset } from '../../../../src/core/settings.js'
import { FontPicker, type InstalledFont } from './FontPicker'
import { ShortcutList } from './ShortcutsPanel'
import { effectiveKeys, keyConflicts } from '../lib/keymap'
import { cockpitApi, type TerminalImport } from '../host/cockpit-api'
import { xtermLook } from '../lib/terminal-look'
import { createCommitter } from '../lib/settings-commit'
import { DEFAULT_REFINE_INSTRUCTION } from '../lib/prompt-defaults'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, findSection, searchSettings } from '../lib/settings-sections'

export type EditorSetting = { kind: 'vscode' | 'cursor' | 'zed' | 'custom' | 'cockpit'; command?: string }
export type LauncherSetting = {
  id: string
  label: string
  command: string
  env: Record<string, string>
  enabled: boolean
  builtin: boolean
}
export type UserSettings = {
  launchers: LauncherSetting[]
  editor: EditorSetting
  layouts: Record<string, unknown>
  terminal?: TerminalAppearance
  appearance?: InterfaceAppearance
  usage?: UsageSettings
  keybindings?: Record<string, string | null>
  persistence?: PersistenceSettings
  prompt?: PromptSettings
  presets?: SessionPreset[]
}

const EDITORS: Array<{ kind: EditorSetting['kind']; label: string }> = [
  { kind: 'vscode', label: 'VS Code' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'zed', label: 'Zed' },
  { kind: 'cockpit', label: 'In the cockpit' },
  { kind: 'custom', label: 'Custom command' },
]

/**
 * Settings (⌘,): the launchers a new session can start with — each one's name, the one
 * line typed into the shell, and extra environment — and which editor Cmd+click opens.
 * Saved per user by the daemon, which validates everything again; this form only shows
 * its answer.
 */
export type NotifyPrefs = { sound: boolean; dockBadge: boolean; finish: boolean }

/** Offered first in the pickers when installed; everything else installed follows. */
const UI_FONTS = ['Inter', 'SF Pro Text', 'SF Pro Display', 'Geist', 'IBM Plex Sans', 'Avenir Next', 'Helvetica Neue', 'JetBrains Mono']
const CODE_FONTS = ['JetBrains Mono', 'JetBrainsMono Nerd Font Mono', 'Fira Code', 'Cascadia Code', 'Cascadia Code NF', 'Geist Mono', 'SF Mono', 'IBM Plex Mono', 'Iosevka', 'Menlo']

const THEMES: Array<{ id: NonNullable<InterfaceAppearance['theme']>; label: string; title: string }> = [
  { id: 'system', label: 'System', title: 'Follow macOS (light or dark)' },
  { id: 'dark', label: 'Dark', title: 'One Dark' },
  { id: 'light', label: 'Light', title: 'One Light' },
  { id: 'terminal', label: 'From terminal', title: 'The whole window in the colors imported under Terminal' },
]

const TEXT_SIZES: Array<{ id: NonNullable<InterfaceAppearance['textSize']>; label: string }> = [
  { id: 'small', label: 'Small' },
  { id: 'default', label: 'Default' },
  { id: 'large', label: 'Large' },
]

const CURSORS: Array<{ id: NonNullable<TerminalAppearance['cursorStyle']>; label: string }> = [
  { id: 'block', label: 'Block' },
  { id: 'bar', label: 'Bar' },
  { id: 'underline', label: 'Underline' },
]

const SECTION_ICONS: Record<string, (p: { class?: string; title?: string }) => preact.JSX.Element> = {
  dashboard: DashboardIcon, appearance: AppearanceIcon, notifications: BellIcon, launchers: LauncherIcon, presets: PresetsIcon,
  prompt: PenIcon, editor: CodeIcon, terminal: TerminalIcon, keyboard: KeyboardIcon, usage: UsageIcon,
}

/** Which news banners the person dismissed: kept in this browser's storage, and the page works without it. */
/**
 * The version check's own switch. It lives in the global config the CLI shares (not in the settings draft that Save
 * writes), so it applies at once and reads its state from main; until that answers it stays off and disabled.
 */
function UpdateCheckSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    cockpitApi.updateStatus().then((s) => { if (live) setEnabled(s.enabled) }, () => undefined)
    return () => { live = false }
  }, [])
  return (
    <Switch label="Tell me about new versions" checked={enabled === true} disabled={enabled === null}
      onChange={(next) => { setEnabled(next); void cockpitApi.updateSetEnabled(next) }} />
  )
}

const BANNER_KEY = 'cw.settings.banner.dashboard.v1'
const readBannerGone = (): boolean => { try { return window.localStorage.getItem(BANNER_KEY) === '1' } catch { return false } }

const TERMINAL_APPS: Array<{ id: 'ghostty' | 'iterm2'; label: string }> = [
  { id: 'ghostty', label: 'Ghostty' },
  { id: 'iterm2', label: 'iTerm2' },
]

export function SettingsPage({ initialSection, initialRow, initial, availability, defaults, notify, onNotify, importSources, onImport, loadFonts, onPreviewAppearance, seenModels, hasTerminalColors, onSave, onClose }: {
  /** Which section to open on, and a row in it to scroll to and highlight (a deep link). */
  initialSection?: string
  initialRow?: string
  initial: UserSettings
  /** Launcher id → whether this machine has its program (from launchers.list). */
  availability: Record<string, boolean>
  /** The shipped form of each built-in, for Reset. */
  defaults: Record<string, { label: string; command: string }>
  /** This window's own notification choices: applied at once, not with Save. */
  notify: NotifyPrefs
  onNotify: (next: NotifyPrefs) => void
  /** Which terminals have settings on this machine (Settings → Terminal's import buttons). */
  importSources: { ghostty: boolean; iterm2: boolean }
  onImport: (from: 'ghostty' | 'iterm2') => Promise<TerminalImport>
  /** The fonts installed on this Mac, for the pickers (read on open; ~0.7 s the first time). */
  loadFonts: () => Promise<InstalledFont[]>
  /**
   * Shows the window in `appearance` now, before Save (the host reverts on Cancel);
   * `terminalColors` is the draft's, so "From terminal" previews a fresh import too.
   */
  onPreviewAppearance: (appearance: InterfaceAppearance | undefined, terminalColors: TerminalAppearance['colors']) => void
  /** Models the agents have used in the open projects, offered for pricing. */
  seenModels: string[]
  /** Colors were imported under Terminal (the "From terminal" theme needs them). */
  hasTerminalColors: boolean
  /** The daemon's answer: null when saved, or the sentence it refused with. */
  onSave: (next: UserSettings) => Promise<string | null>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<UserSettings>(initial)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  /** The env textarea as typed, per launcher, until it parses. */
  const [envText, setEnvText] = useState<Record<string, string>>({})
  /** What the last import said (a font not installed, a theme not found), or why it failed. */
  const [importNote, setImportNote] = useState<{ text: string; error: boolean } | null>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const [fonts, setFonts] = useState<InstalledFont[]>([])

  useEffect(() => {
    let live = true
    void loadFonts().then((list) => { if (live) setFonts(list) }).catch(() => undefined)
    return () => { live = false }
  }, [loadFonts])

  const setAppearance = (patch: Partial<InterfaceAppearance>): void => {
    const next: InterfaceAppearance = { ...draft.appearance, ...patch }
    for (const key of Object.keys(next) as Array<keyof InterfaceAppearance>) if (next[key] === undefined) delete next[key]
    const appearance = Object.keys(next).length === 0 ? undefined : next
    setDraft({ ...draft, appearance })
    onPreviewAppearance(appearance, draft.terminal?.colors)
  }

  const setTerminal = (patch: Partial<TerminalAppearance>): void => {
    const next: TerminalAppearance = { ...draft.terminal, ...patch }
    for (const key of Object.keys(next) as Array<keyof TerminalAppearance>) if (next[key] === undefined) delete next[key]
    setDraft({ ...draft, terminal: next })
  }

  const runImport = async (from: 'ghostty' | 'iterm2', label: string): Promise<void> => {
    setImporting(from)
    setImportNote(null)
    try {
      const result = await onImport(from)
      if (!result.ok) {
        setImportNote({ text: result.reason, error: true })
        return
      }
      // A draft: nothing is written until Save.
      setDraft({ ...draft, terminal: result.appearance })
      setImportNote({ text: [`Imported from ${label} — review, then Save.`, ...result.notes].join(' '), error: false })
    } catch (err) {
      setImportNote({ text: err instanceof Error ? err.message : String(err), error: true })
    } finally {
      setImporting(null)
    }
  }

  const [newModel, setNewModel] = useState('')
  const prices = draft.usage?.prices ?? {}
  const pricedModels = [...new Set([...seenModels, ...Object.keys(prices)])].sort()
  // From the latest draft, not this render's: several fields edited before a re-render
  // (or quickly, one after another) each kept only the last.
  const setPrice = (model: string, kind: keyof ModelPrice, value: string): void => {
    const n = Number(value)
    setDraft((d) => {
      const all = d.usage?.prices ?? {}
      const current = all[model] ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
      return { ...d, usage: { ...d.usage, prices: { ...all, [model]: { ...current, [kind]: Number.isFinite(n) && n >= 0 ? n : 0 } } } }
    })
  }
  const removePrice = (model: string): void => {
    setDraft((d) => {
      const all = { ...(d.usage?.prices ?? {}) }
      delete all[model]
      return { ...d, usage: { ...d.usage, prices: all } }
    })
  }

  const look = xtermLook(draft.terminal)
  const ansi = [look.theme.black, look.theme.red, look.theme.green, look.theme.yellow, look.theme.blue, look.theme.magenta, look.theme.cyan, look.theme.white,
    look.theme.brightBlack, look.theme.brightRed, look.theme.brightGreen, look.theme.brightYellow, look.theme.brightBlue, look.theme.brightMagenta, look.theme.brightCyan, look.theme.brightWhite]

  const update = (id: string, patch: Partial<LauncherSetting>): void => {
    setDraft({ ...draft, launchers: draft.launchers.map((l) => (l.id === id ? { ...l, ...patch } : l)) })
  }

  const addLauncher = (): void => {
    const id = launcherIdFor('My launcher', draft.launchers.map((l) => l.id))
    setDraft({ ...draft, launchers: [...draft.launchers, { id, label: 'My launcher', command: '', env: {}, enabled: true, builtin: false }] })
    setOpen(id)
  }

  // Every change is saved as it is made (after a short pause), through the same daemon
  // call the old Save button used, so its validation is unchanged. A refusal does not
  // discard what was typed: it says why, and the next change that fixes it saves it.
  const savedRef = useRef<UserSettings>(initial)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const [notSaved, setNotSaved] = useState<string | null>(null)
  const committer = useMemo(() => createCommitter<UserSettings>({
    save: (value) => onSaveRef.current(value),
    onResult: (value, problem) => {
      if (problem === null) {
        savedRef.current = value
        setNotSaved(null)
      } else {
        setNotSaved(problem)
      }
    },
  }), [])
  useEffect(() => () => committer.cancel(), [committer])

  useEffect(() => {
    if (draft === savedRef.current) return
    // Two commands on one chord: the menu would silently keep only one of them.
    if (keyConflicts(effectiveKeys(draft.keybindings)).length > 0) {
      setError('Two commands share a shortcut — change one of them under Keyboard')
      return
    }
    // Every env box must parse before anything is sent.
    for (const [id, text] of Object.entries(envText)) {
      const parsed = parseEnvLines(text)
      if (!parsed.ok) {
        setOpen(id)
        setError(`${draft.launchers.find((l) => l.id === id)?.label ?? id}: ${parsed.error}`)
        return
      }
    }
    setError(null)
    committer.schedule(draft)
  }, [draft])

  const close = async (): Promise<void> => {
    await committer.flush()
    onClose()
  }

  const [bannerGone, setBannerGone] = useState(readBannerGone)
  const dismissBanner = (): void => {
    setBannerGone(true)
    try { window.localStorage.setItem(BANNER_KEY, '1') } catch { /* storage can be full or disabled: the banner just comes back next time */ }
  }
  const [section, setSection] = useState(() => findSection(initialSection ?? '')?.id ?? SETTINGS_SECTIONS[0]!.id)
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<string | null>(initialRow ?? null)
  const contentRef = useRef<HTMLElement>(null)
  const hits = searchSettings(query)
  const searching = query.trim() !== ''

  // A search hit or deep link: scroll the row into view and mark it for a moment.
  useEffect(() => {
    if (target === null || searching) return
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-setting="${target}"]`)
    setTarget(null)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.classList.add('is-target')
    const t = setTimeout(() => el.classList.remove('is-target'), 1600)
    return () => clearTimeout(t)
  }, [target, section, searching])

  const presets = draft.presets ?? []
  /** Replace preset `i` with `next`, or remove it (null); an empty list is no block at all. */
  const setPreset = (i: number, next: SessionPreset | null): void => {
    setDraft((d) => {
      const list = [...(d.presets ?? [])]
      if (next === null) list.splice(i, 1)
      else list[i] = next
      return { ...d, presets: list.length === 0 ? undefined : list }
    })
  }
  const patchPreset = (i: number, patch: Partial<SessionPreset>): void => {
    const next: SessionPreset = { ...presets[i]!, ...patch }
    for (const key of Object.keys(next) as Array<keyof SessionPreset>) if (next[key] === undefined) delete next[key]
    setPreset(i, next)
  }
  const setRefine = (patch: Partial<NonNullable<PromptSettings['refine']>>): void => {
    setDraft((d) => {
      const next = { ...d.prompt?.refine, ...patch }
      for (const key of Object.keys(next) as Array<keyof typeof next>) if (next[key] === undefined || next[key] === '') delete next[key]
      return { ...d, prompt: Object.keys(next).length === 0 ? undefined : { refine: next } }
    })
  }

  const bodies: Record<string, ComponentChildren> = {
    dashboard: <SettingsDashboard />,
    appearance: (
      <>
        <SettingsGroup title="Fonts" note="Shown as you choose, saved as you choose.">
          <SettingRow id="appearance-ui-font">
            <FontPicker label="Interface font" value={draft.appearance?.uiFont} fonts={fonts} suggestions={UI_FONTS}
              defaultLabel="System (SF Pro)" onChange={(uiFont) => setAppearance({ uiFont })} />
          </SettingRow>
          <SettingRow id="appearance-code-font">
            <FontPicker label="Code font" value={draft.appearance?.codeFont} fonts={fonts} suggestions={CODE_FONTS} mono
              defaultLabel="Menlo" onChange={(codeFont) => setAppearance({ codeFont })} />
          </SettingRow>
        </SettingsGroup>
        <SettingsGroup title="Window">
          <SettingRow id="appearance-theme">
            <Segmented label="Theme" value={draft.appearance?.theme ?? 'system'} options={THEMES}
              disabledIds={!hasTerminalColors && draft.terminal?.colors === undefined ? ['terminal'] : []}
              onChange={(id) => setAppearance({ theme: id === 'system' ? undefined : id })} />
          </SettingRow>
          <SettingRow id="appearance-text-size">
            <Segmented label="Text size" value={draft.appearance?.textSize ?? 'default'} options={TEXT_SIZES}
              onChange={(id) => setAppearance({ textSize: id === 'default' ? undefined : id })} />
          </SettingRow>
        </SettingsGroup>
      </>
    ),
    terminal: (
      <>
        <SettingsGroup title="Import" note={importNote ? <span class={importNote.error ? 'cockpit-error' : ''} role={importNote.error ? 'alert' : 'status'}>{importNote.text}</span> : undefined}>
          <SettingRow id="terminal-import">
            {TERMINAL_APPS.map((app) => (
              <button key={app.id} type="button" class="cockpit-btn cockpit-btn--sm"
                disabled={!importSources[app.id] || importing !== null}
                title={importSources[app.id] ? `Read ${app.label}'s settings (it is applied as you go)` : `No ${app.label} settings found on this Mac`}
                onClick={() => { void runImport(app.id, app.label) }}>
                {importing === app.id ? 'Importing…' : app.label}
              </button>
            ))}
            <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" disabled={draft.terminal === undefined}
              onClick={() => { setDraft({ ...draft, terminal: undefined }); setImportNote(null) }}>
              Use default
            </button>
          </SettingRow>
        </SettingsGroup>
        <SettingsGroup title="Preview">
          {/* The preview paints with the imported colors themselves: they are data, not the chrome's tokens. */}
          <div class="cockpit-scard__block">
            <div class="cockpit-term__preview" aria-label="Terminal preview"
              style={{ background: look.theme.background, color: look.theme.foreground, fontFamily: look.fontFamily, fontSize: `${look.fontSize}px` }}>
              <div>
                <span style={{ color: look.theme.blue }}>~/project</span> <span style={{ color: look.theme.magenta }}>main</span>{' '}
                <span style={{ color: look.theme.green }}>❯</span> claude --continue
                <span class={`cockpit-term__cursor is-${look.cursorStyle}`} style={{ background: look.cursorStyle === 'block' ? look.theme.cursor : undefined, borderColor: look.theme.cursor }} />
              </div>
              <div class="cockpit-term__ansi">
                {ansi.map((color, i) => <span key={i} style={{ background: color }} title={`ANSI ${i}`} />)}
              </div>
            </div>
          </div>
        </SettingsGroup>
        <SettingsGroup title="Text">
          <SettingRow id="terminal-font">
            <FontPicker label="Terminal font" value={draft.terminal?.fontFamily} fonts={fonts} suggestions={CODE_FONTS} mono
              defaultLabel="Menlo" onChange={(fontFamily) => setTerminal({ fontFamily })} />
          </SettingRow>
          <SettingRow id="terminal-size">
            <input type="number" min={8} max={32} value={draft.terminal?.fontSize ?? ''} placeholder="13" aria-label="Terminal font size"
              onInput={(e) => {
                const n = Number((e.target as HTMLInputElement).value)
                setTerminal({ fontSize: Number.isInteger(n) && n > 0 ? n : undefined })
              }} />
          </SettingRow>
          <SettingRow id="terminal-cursor">
            <Segmented label="Cursor" value={draft.terminal?.cursorStyle ?? 'block'} options={CURSORS}
              onChange={(cursorStyle) => setTerminal({ cursorStyle })} />
          </SettingRow>
          <SettingRow id="terminal-blink">
            <Switch label="Blinking cursor" checked={draft.terminal?.cursorBlink ?? true} onChange={(cursorBlink) => setTerminal({ cursorBlink })} />
          </SettingRow>
        </SettingsGroup>
        <SettingsGroup title="Behavior">
          <SettingRow id="terminal-persist">
            <Switch label="Keep terminals across a daemon restart" checked={draft.persistence?.terminals === true}
              onChange={(on) => setDraft((d) => ({ ...d, persistence: on ? { ...d.persistence, terminals: true } : undefined }))} />
          </SettingRow>
          <SettingRow id="terminal-option-meta">
            <Switch label="Option key sends Meta" checked={draft.terminal?.optionAsMeta ?? false} onChange={(optionAsMeta) => setTerminal({ optionAsMeta })} />
          </SettingRow>
        </SettingsGroup>
      </>
    ),
    keyboard: (
      <SettingsGroup note="Change records the next keys you press; the menu updates as it is saved.">
        <SettingRow id="keyboard-shortcuts" stacked>
          <ShortcutList keybindings={draft.keybindings}
            onChange={(next) => setDraft((d) => ({ ...d, keybindings: Object.keys(next).length === 0 ? undefined : next }))} />
        </SettingRow>
      </SettingsGroup>
    ),
    launchers: (
      <SettingsGroup
        title="Launchers"
        dataSetting="launchers-list"
        note={<>What a new session can start with. The command is typed into the session's shell, in its worktree; when it exits you are back at the prompt. Your aliases and wrappers work (e.g. <code>cx</code>).</>}
      >
        {draft.launchers.map((l) => {
          const available = availability[l.id]
          const expanded = open === l.id
          return (
            <div key={l.id} class={`cockpit-slauncher${expanded ? ' is-open' : ''}`}>
              <div class="cockpit-srow">
                <div class="cockpit-slauncher__id">
                  <Switch label={`${l.label} on`} checked={l.enabled} onChange={(enabled) => update(l.id, { enabled })} />
                  <AgentMark agent={l.id} />
                  <div class="cockpit-srow__text">
                    <div class="cockpit-srow__label">{l.label}</div>
                    <div class="cockpit-srow__desc"><code>{l.command || '—'}</code></div>
                  </div>
                </div>
                <div class="cockpit-srow__control">
                  <span class={`cockpit-launcher__state${available ? ' is-ok' : ''}`}>
                    {available === undefined ? 'unsaved' : available ? 'installed' : 'not installed'}
                  </span>
                  <button type="button" class="cockpit-btn cockpit-btn--sm" aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : l.id)}>{expanded ? 'Done' : 'Edit'}</button>
                </div>
              </div>
              {expanded ? (
                <div class="cockpit-scard__block cockpit-launcher__form">
                  <label class="cockpit-picker__field">
                    <span class="cockpit-muted">Name</span>
                    <input value={l.label} onInput={(e) => update(l.id, { label: (e.target as HTMLInputElement).value })} />
                  </label>
                  <label class="cockpit-picker__field">
                    <span class="cockpit-muted">Command — one line, flags included</span>
                    <input class="cockpit-settings__command" value={l.command} spellcheck={false}
                      placeholder="claude --model opus --dangerously-skip-permissions"
                      onInput={(e) => update(l.id, { command: (e.target as HTMLInputElement).value })} />
                  </label>
                  <label class="cockpit-picker__field">
                    <span class="cockpit-muted">Environment — NAME=value per line</span>
                    <textarea class="cockpit-settings__env" rows={3} spellcheck={false}
                      value={envText[l.id] ?? formatEnvLines(l.env)}
                      placeholder={'ANTHROPIC_MODEL=claude-opus\nHTTPS_PROXY=http://127.0.0.1:8080'}
                      onInput={(e) => {
                        const text = (e.target as HTMLTextAreaElement).value
                        setEnvText({ ...envText, [l.id]: text })
                        const parsed = parseEnvLines(text)
                        if (parsed.ok) update(l.id, { env: parsed.env })
                      }} />
                  </label>
                  <div class="cockpit-launcher__actions">
                    {l.builtin ? (
                      <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => {
                        const d = defaults[l.id]
                        if (d) update(l.id, { label: d.label, command: d.command, env: {} })
                        const rest = { ...envText }
                        delete rest[l.id]
                        setEnvText(rest)
                      }}>Reset to default</button>
                    ) : (
                      <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--danger" onClick={() => {
                        setDraft({ ...draft, launchers: draft.launchers.filter((x) => x.id !== l.id) })
                        setOpen(null)
                      }}>Delete</button>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
        <div class="cockpit-scard__block">
          <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={addLauncher}>+ Add launcher</button>
        </div>
      </SettingsGroup>
    ),
    editor: (
      <SettingsGroup title="Cmd+click opens files in">
        <SettingRow id="editor-open-in">
          <select aria-label="Editor" value={draft.editor.kind}
            onChange={(e) => {
              const kind = (e.target as HTMLSelectElement).value as EditorSetting['kind']
              setDraft({ ...draft, editor: { kind, ...(kind === 'custom' ? { command: draft.editor.command ?? '' } : {}) } })
            }}>
            {EDITORS.map((e) => <option key={e.kind} value={e.kind}>{e.label}</option>)}
          </select>
        </SettingRow>
        {draft.editor.kind === 'custom' ? (
          <SettingRow id="editor-command" label="Command" description={<>{'{file}'}, {'{line}'} and {'{col}'} are filled in</>} stacked>
            <input value={draft.editor.command ?? ''} placeholder='subl "{file}:{line}:{col}"' spellcheck={false} aria-label="Editor command"
              onInput={(e) => setDraft({ ...draft, editor: { kind: 'custom', command: (e.target as HTMLInputElement).value } })} />
          </SettingRow>
        ) : null}
      </SettingsGroup>
    ),
    notifications: (
      <SettingsGroup title="When a session needs you" note="When a session waits for you, or its agent finishes, while you look elsewhere (another app, project or tab). These apply right away.">
        <SettingRow id="notify-finish">
          <Switch label="Also when an agent finishes" checked={notify.finish} onChange={(finish) => onNotify({ ...notify, finish })} />
        </SettingRow>
        <SettingRow id="notify-sound">
          <Switch label="Play a sound" checked={notify.sound} onChange={(sound) => onNotify({ ...notify, sound })} />
        </SettingRow>
        <SettingRow id="notify-dock">
          <Switch label="Count them on the Dock icon" checked={notify.dockBadge} onChange={(dockBadge) => onNotify({ ...notify, dockBadge })} />
        </SettingRow>
        <SettingRow id="notify-updates">
          <UpdateCheckSwitch />
        </SettingRow>
      </SettingsGroup>
    ),
    presets: (
      <>
        <SettingsGroup
          dataSetting="preset-list"
          note="A preset starts a session in one click from the new-session picker (⌘T): the launcher, an own worktree or not, shells that each run a command, and a Browser pane on the session's leased port. The commands are typed and run for you, so they are yours alone: they live in this settings file, never in a repository."
        >
          <div class="cockpit-scard__block">
            <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={presets.length >= 12}
              onClick={() => setPreset(presets.length, { name: `preset ${presets.length + 1}` })}>Add a preset</button>
          </div>
        </SettingsGroup>
        {presets.map((preset, i) => (
          <SettingsGroup key={i} title={preset.name || 'Preset'}>
            <SettingRow id={`preset-${i}-name`} label="Name">
              <input value={preset.name} spellcheck={false} maxLength={40} aria-label="Preset name" onInput={(e) => patchPreset(i, { name: (e.target as HTMLInputElement).value })} />
            </SettingRow>
            <SettingRow id={`preset-${i}-launcher`} label="Start with">
              <select aria-label="Start with" value={preset.launcher ?? 'terminal'}
                onChange={(e) => { const v = (e.target as HTMLSelectElement).value; patchPreset(i, { launcher: v === 'terminal' ? undefined : v }) }}>
                <option value="terminal">Terminal</option>
                {draft.launchers.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </SettingRow>
            <SettingRow id={`preset-${i}-worktree`} label="Own worktree" description="Off: the project folder itself">
              <Switch label="Own worktree" checked={preset.worktree !== false} onChange={(on) => patchPreset(i, { worktree: on ? undefined : false })} />
            </SettingRow>
            <SettingRow id={`preset-${i}-terminals`} label="Terminals" description="One command per line, up to 4; each runs in its own shell beside the session" stacked>
              <textarea rows={3} spellcheck={false} aria-label="Terminal commands" value={(preset.terminals ?? []).join('\n')} placeholder="bun dev"
                onInput={(e) => { const lines = (e.target as HTMLTextAreaElement).value.split('\n').filter((l) => l.trim() !== ''); patchPreset(i, { terminals: lines.length === 0 ? undefined : lines }) }} />
            </SettingRow>
            <SettingRow id={`preset-${i}-browser`} label="Browser pane" description="Open a Browser pane on the session's port">
              <Switch label="Browser pane" checked={preset.browser !== undefined} onChange={(on) => patchPreset(i, { browser: on ? {} : undefined })} />
            </SettingRow>
            {preset.browser !== undefined ? (
              <SettingRow id={`preset-${i}-path`} label="Browser path">
                <input class="cockpit-settings__command" value={preset.browser.path ?? ''} spellcheck={false} placeholder="/" aria-label="Browser path"
                  onInput={(e) => { const v = (e.target as HTMLInputElement).value; patchPreset(i, { browser: v === '' ? {} : { path: v } }) }} />
              </SettingRow>
            ) : null}
            <div class="cockpit-scard__block">
              <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--danger" onClick={() => setPreset(i, null)}>Remove {preset.name || 'preset'}</button>
            </div>
          </SettingsGroup>
        ))}
      </>
    ),
    prompt: (
      <SettingsGroup title="Refine" note="The prompt composer (⌘⇧P) writes one prompt and sends it to one or several sessions. Refine is optional: the program below is yours (this app does not choose an AI); it reads the draft and prints a better one, which you read before it goes anywhere. Empty means the composer has no Refine button.">
        <SettingRow id="prompt-refine-command">
          <input class="cockpit-settings__command" value={draft.prompt?.refine?.command ?? ''} spellcheck={false} placeholder="claude -p" aria-label="Refine command"
            onInput={(e) => setRefine({ command: (e.target as HTMLInputElement).value })} />
        </SettingRow>
        <SettingRow id="prompt-refine-instruction" stacked>
          <textarea rows={5} spellcheck={false} value={draft.prompt?.refine?.instruction ?? ''} placeholder={DEFAULT_REFINE_INSTRUCTION} aria-label="Refine instruction"
            onInput={(e) => setRefine({ instruction: (e.target as HTMLTextAreaElement).value })} />
        </SettingRow>
        <SettingRow id="prompt-refine-context">
          <Switch label="Include session context" checked={draft.prompt?.refine?.includeContext === true} onChange={(on) => setRefine({ includeContext: on ? true : undefined })} />
        </SettingRow>
      </SettingsGroup>
    ),
    usage: (
      <>
        <SettingsGroup title="Tokens and cost" note="Tokens the agents in each session have used, read from their own logs (Claude Code, Codex). The logs carry no prices — add yours (USD per million tokens) to see cost; a model without a price shows as tokens.">
          <SettingRow id="usage-show" label="Show usage on the rail" description="Each row's token count (and cost, for a model you priced)">
            <Switch label="Show usage on the rail" checked={draft.usage?.show ?? true}
              onChange={(show) => setDraft({ ...draft, usage: { ...draft.usage, show } })} />
          </SettingRow>
        </SettingsGroup>
        <SettingsGroup title="Prices">
          <SettingRow id="usage-prices" stacked label="Prices per million tokens" description={pricedModels.length === 0 ? 'No agent usage seen yet in the open projects.' : undefined}>
            {pricedModels.length > 0 ? (
              <table class="cockpit-prices">
                <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache write</th><th>Cache read</th><th /></tr></thead>
                <tbody>
                  {pricedModels.map((model) => (
                    <tr key={model}>
                      <td><code>{model}</code></td>
                      {(['input', 'output', 'cacheWrite', 'cacheRead'] as const).map((kind) => (
                        <td key={kind}>
                          <input type="number" min={0} step="0.01" aria-label={`${model} ${kind} price`} placeholder="—"
                            value={prices[model]?.[kind] ?? ''} onInput={(e) => setPrice(model, kind, (e.target as HTMLInputElement).value)} />
                        </td>
                      ))}
                      <td>{prices[model] ? <button type="button" class="cockpit-iconbtn" aria-label={`Remove ${model} price`} onClick={() => removePrice(model)}>×</button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <div class="cockpit-prices__add">
              <input class="cockpit-field--mono" value={newModel} placeholder="another model, e.g. claude-opus-5-5" spellcheck={false} aria-label="Another model"
                onInput={(e) => setNewModel((e.target as HTMLInputElement).value.trim())} />
              <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={newModel === '' || newModel in prices}
                onClick={() => { setPrice(newModel, 'input', '0'); setNewModel('') }}>Add model</button>
            </div>
          </SettingRow>
        </SettingsGroup>
      </>
    ),
  }

  const title = findSection(section)?.title
  return (
    <div
      class="cockpit-settings-page"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onKeyDown={(e) => { if (e.key === 'Escape') void close() }}
    >
      <nav class="cockpit-settings-nav" aria-label="Settings sections">
        <div class="cockpit-settings-nav__drag" />
        <button type="button" class="cockpit-settings-nav__back" onClick={() => { void close() }}><BackIcon /> Back</button>
        <input class="cockpit-settings-nav__search" type="search" placeholder="Search settings" aria-label="Search settings" spellcheck={false}
          value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        {SETTINGS_GROUPS.map((g) => (
          <div key={g.id} class="cockpit-settings-nav__group" role="group">
            {g.sections.map((id) => {
              const s = findSection(id)
              if (s === undefined) return null
              const Icon = SECTION_ICONS[id]
              return (
                <button key={id} type="button" class={`cockpit-settings-nav__item${!searching && section === id ? ' is-active' : ''}`}
                  aria-current={!searching && section === id ? 'page' : undefined}
                  onClick={() => { setQuery(''); setSection(id) }}>
                  {Icon ? <Icon /> : null}
                  <span>{s.title}</span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>
      <main class="cockpit-settings-content" ref={contentRef}>
        <div class="cockpit-settings-content__drag" />
        <div class="cockpit-settings-content__inner">
          {!bannerGone && !searching && section !== 'dashboard' ? (
            <Banner title="New: Dashboard" actionLabel="Open Dashboard" onAction={() => setSection('dashboard')} onDismiss={dismissBanner}>
              See what your sessions and worktrees cost in disk and memory, and what you could stop or delete to lighten the machine.
            </Banner>
          ) : null}
          {notSaved !== null ? (
            <p class="cockpit-error cockpit-settings-content__unsaved" role="alert">Not saved — {notSaved}</p>
          ) : null}
          {error ? <p class="cockpit-error" role="alert">{error}</p> : null}
          {searching ? (
            hits.length === 0 ? <p class="cockpit-muted cockpit-settings-content__empty">No settings match “{query.trim()}”.</p> : (
              <>
                {hits.map((g) => (
                  <SettingsGroup key={g.section.id} title={g.section.title}>
                    {g.rows.map((r) => (
                      <button key={r.id} type="button" class="cockpit-sresult"
                        onClick={() => { setQuery(''); setSection(g.section.id); setTarget(r.id) }}>
                        <span class="cockpit-srow__label">{r.label}</span>
                        <span class="cockpit-srow__desc">{r.description}</span>
                      </button>
                    ))}
                  </SettingsGroup>
                ))}
              </>
            )
          ) : (
            <section>
              <h2 class="cockpit-settings-content__title">{title}</h2>
              {bodies[section]}
            </section>
          )}
        </div>
      </main>
    </div>
  )
}
