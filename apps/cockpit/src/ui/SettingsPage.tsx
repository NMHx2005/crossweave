import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { formatEnvLines, launcherIdFor, parseEnvLines } from '../lib/launchers'
import { AgentMark } from './icons'
import type { InterfaceAppearance, ModelPrice, TerminalAppearance, UsageSettings, VoiceSettings } from '../../../../src/core/settings.js'
import { FontPicker, type InstalledFont } from './FontPicker'
import { ShortcutList } from './ShortcutsPanel'
import { effectiveKeys, keyConflicts } from '../lib/keymap'
import { cockpitApi, type TerminalImport } from '../host/cockpit-api'
import { startRecording } from '../lib/voice-recorder'
import { DEFAULT_REFINE_INSTRUCTION } from '../lib/voice-defaults'
import { isPhantomTranscript, isSilent, SILENCE_MESSAGE } from '../lib/voice-audio'
import { xtermLook } from '../lib/terminal-look'
import { createCommitter } from '../lib/settings-commit'
import { SETTINGS_SECTIONS, findSection, searchSettings } from '../lib/settings-sections'

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
  voice?: VoiceSettings
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

  const setVoice = (patch: Partial<VoiceSettings>): void => {
    setDraft((d) => {
      const next: VoiceSettings = { ...d.voice, ...patch }
      for (const key of Object.keys(next) as Array<keyof VoiceSettings>) if (next[key] === undefined) delete next[key]
      return { ...d, voice: Object.keys(next).length === 0 ? undefined : next }
    })
  }
  const setRefine = (patch: Partial<NonNullable<VoiceSettings['refine']>>): void => {
    const next = { ...draft.voice?.refine, ...patch }
    for (const key of Object.keys(next) as Array<keyof typeof next>) if (next[key] === undefined || next[key] === '') delete next[key]
    setVoice({ refine: Object.keys(next).length === 0 ? undefined : next })
  }
  const snippets = draft.voice?.snippets ?? []
  const setSnippets = (list: NonNullable<VoiceSettings['snippets']>): void => setVoice({ snippets: list.length === 0 ? undefined : list })
  const [voiceTest, setVoiceTest] = useState<{ phase: 'idle' | 'recording' | 'working'; result?: string; error?: string; level?: number }>({ phase: 'idle' })
  // Records three seconds and runs the SAVED transcribe command (the main process reads
  // the settings file itself), so a broken command is found here and not mid-prompt.
  const runVoiceTest = async (): Promise<void> => {
    setVoiceTest({ phase: 'recording' })
    try {
      const access = await cockpitApi.voiceMicAccess()
      if (access.status !== 'granted') {
        setVoiceTest({ phase: 'idle', error: 'Microphone access is off. Allow it in System Settings → Privacy & Security → Microphone.' })
        return
      }
      const rec = await startRecording({ maxSeconds: 5, onLimit: () => undefined })
      // Three seconds, with the level shown so a dead microphone is obvious.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100))
        setVoiceTest({ phase: 'recording', level: rec.level() })
      }
      setVoiceTest({ phase: 'working' })
      const audio = await rec.stop()
      if (isSilent(audio.stats)) {
        setVoiceTest({ phase: 'idle', error: SILENCE_MESSAGE })
        return
      }
      const result = await cockpitApi.voiceTranscribe(audio.wav)
      if (!result.ok) setVoiceTest({ phase: 'idle', error: result.reason })
      else if (isPhantomTranscript(result.text, audio.stats.peak)) setVoiceTest({ phase: 'idle', error: SILENCE_MESSAGE })
      else setVoiceTest({ phase: 'idle', result: result.text })
    } catch (err) {
      setVoiceTest({ phase: 'idle', error: err instanceof Error ? err.message : String(err) })
    }
  }

  const bodies: Record<string, ComponentChildren> = {
    appearance: (
      <>
        <p class="cockpit-muted">The window's fonts and text size — shown as you choose, saved as you choose.</p>
        <div class="cockpit-settings__fonts">
          <div class="cockpit-picker__field" data-setting="appearance-ui-font">
            <span class="cockpit-muted">Interface font</span>
            <FontPicker label="Interface font" value={draft.appearance?.uiFont} fonts={fonts} suggestions={UI_FONTS}
              defaultLabel="System (SF Pro)" onChange={(uiFont) => setAppearance({ uiFont })} />
          </div>
          <div class="cockpit-picker__field" data-setting="appearance-code-font">
            <span class="cockpit-muted" title="Commands, paths, branches and the file editor">Code font</span>
            <FontPicker label="Code font" value={draft.appearance?.codeFont} fonts={fonts} suggestions={CODE_FONTS} mono
              defaultLabel="Menlo" onChange={(codeFont) => setAppearance({ codeFont })} />
          </div>
        </div>
        <div class="cockpit-settings__segmented" role="radiogroup" aria-label="Theme" data-setting="appearance-theme">
          <span class="cockpit-muted">Theme</span>
          {THEMES.map((t) => {
            const disabled = t.id === 'terminal' && !hasTerminalColors && draft.terminal?.colors === undefined
            const on = (draft.appearance?.theme ?? 'system') === t.id
            return (
              <button key={t.id} type="button" role="radio" aria-checked={on} disabled={disabled}
                title={disabled ? 'Import colors under Terminal first (from Ghostty or iTerm2)' : t.title}
                class={`cockpit-btn cockpit-btn--sm${on ? ' cockpit-btn--primary' : ''}`}
                onClick={() => setAppearance({ theme: t.id === 'system' ? undefined : t.id })}>
                {t.label}
              </button>
            )
          })}
        </div>
        <div class="cockpit-settings__segmented" role="radiogroup" aria-label="Text size" data-setting="appearance-text-size">
          <span class="cockpit-muted">Text size</span>
          {TEXT_SIZES.map((size) => (
            <button key={size.id} type="button" role="radio" aria-checked={(draft.appearance?.textSize ?? 'default') === size.id}
              class={`cockpit-btn cockpit-btn--sm${(draft.appearance?.textSize ?? 'default') === size.id ? ' cockpit-btn--primary' : ''}`}
              onClick={() => setAppearance({ textSize: size.id === 'default' ? undefined : size.id })}>
              {size.label}
            </button>
          ))}
        </div>
      </>
    ),
    terminal: (
      <>
        <p class="cockpit-muted">
          How the panes look. Import from the terminal you use — font, size, colors, cursor and the Option key — then adjust.
        </p>
        <div class="cockpit-term__actions" data-setting="terminal-import">
          {TERMINAL_APPS.map((app) => (
            <button key={app.id} type="button" class="cockpit-btn cockpit-btn--sm"
              disabled={!importSources[app.id] || importing !== null}
              title={importSources[app.id] ? `Read ${app.label}'s settings (it is applied as you go)` : `No ${app.label} settings found on this Mac`}
              onClick={() => { void runImport(app.id, app.label) }}>
              {importing === app.id ? 'Importing…' : `Import from ${app.label}`}
            </button>
          ))}
          <span class="cockpit-sidebar__spring" />
          <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" disabled={draft.terminal === undefined}
            onClick={() => { setDraft({ ...draft, terminal: undefined }); setImportNote(null) }}>
            Use cockpit default
          </button>
        </div>
        {importNote ? <p class={importNote.error ? 'cockpit-error' : 'cockpit-muted'} role={importNote.error ? 'alert' : 'status'}>{importNote.text}</p> : null}
        {/* The preview paints with the imported colors themselves: they are data, not the chrome's tokens. */}
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
        <div class="cockpit-term__fields">
          <div class="cockpit-picker__field" data-setting="terminal-font">
            <span class="cockpit-muted">Font</span>
            <FontPicker label="Terminal font" value={draft.terminal?.fontFamily} fonts={fonts} suggestions={CODE_FONTS} mono
              defaultLabel="Menlo" onChange={(fontFamily) => setTerminal({ fontFamily })} />
          </div>
          <label class="cockpit-picker__field" data-setting="terminal-size">
            <span class="cockpit-muted">Size</span>
            <input type="number" min={8} max={32} value={draft.terminal?.fontSize ?? ''} placeholder="13"
              onInput={(e) => {
                const n = Number((e.target as HTMLInputElement).value)
                setTerminal({ fontSize: Number.isInteger(n) && n > 0 ? n : undefined })
              }} />
          </label>
          <label class="cockpit-picker__field" data-setting="terminal-cursor">
            <span class="cockpit-muted">Cursor</span>
            <select value={draft.terminal?.cursorStyle ?? 'block'}
              onChange={(e) => setTerminal({ cursorStyle: (e.target as HTMLSelectElement).value as TerminalAppearance['cursorStyle'] })}>
              <option value="block">Block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </select>
          </label>
        </div>
        <label class="cockpit-settings__toggle" data-setting="terminal-blink">
          <input type="checkbox" checked={draft.terminal?.cursorBlink ?? true} onChange={(e) => setTerminal({ cursorBlink: (e.target as HTMLInputElement).checked })} />
          <span>Blinking cursor</span>
        </label>
        <label class="cockpit-settings__toggle" data-setting="terminal-option-meta">
          <input type="checkbox" checked={draft.terminal?.optionAsMeta ?? false} onChange={(e) => setTerminal({ optionAsMeta: (e.target as HTMLInputElement).checked })} />
          <span>Option key sends Meta (Esc+), for Alt shortcuts in the shell and in agents</span>
        </label>
      </>
    ),
    keyboard: (
      <>
        <p class="cockpit-muted">Every command's shortcut. Change records the next keys you press; the menu updates as it is saved.</p>
        <div data-setting="keyboard-shortcuts">
        <ShortcutList keybindings={draft.keybindings}
          onChange={(next) => setDraft((d) => ({ ...d, keybindings: Object.keys(next).length === 0 ? undefined : next }))} />
        </div>
      </>
    ),
    launchers: (
      <>
        <p class="cockpit-muted">
          What a new session can start with. The command is typed into the session's shell, in its
          worktree; when it exits you are back at the prompt. Your aliases and wrappers work (e.g. <code>cx</code>).
        </p>
        <div data-setting="launchers-list">
        <ul class="cockpit-launchers">
          {draft.launchers.map((l) => {
            const available = availability[l.id]
            const expanded = open === l.id
            return (
              <li key={l.id} class={`cockpit-launcher${expanded ? ' is-open' : ''}`}>
                <div class="cockpit-launcher__row">
                  <input type="checkbox" checked={l.enabled} aria-label={`${l.label} on`}
                    onChange={(e) => update(l.id, { enabled: (e.target as HTMLInputElement).checked })} />
                  <AgentMark agent={l.id} />
                  <span class="cockpit-launcher__label">{l.label}</span>
                  <code class="cockpit-launcher__command">{l.command || '—'}</code>
                  <span class={`cockpit-launcher__state${available ? ' is-ok' : ''}`}>
                    {available === undefined ? 'unsaved' : available ? 'installed' : 'not installed'}
                  </span>
                  <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-launcher__edit" aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : l.id)}>{expanded ? 'Done' : 'Edit'}</button>
                </div>
                {expanded ? (
                  <div class="cockpit-launcher__form">
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
              </li>
            )
          })}
        </ul>
        <button type="button" class="cockpit-btn cockpit-btn--ghost cockpit-launchers__add" onClick={addLauncher}>+ Add launcher</button>
        </div>
      </>
    ),
    editor: (
      <>
        <div class="cockpit-settings__editors" role="radiogroup" aria-label="Editor" data-setting="editor-open-in">
          {EDITORS.map((e) => (
            <label key={e.kind} class="cockpit-settings__toggle">
              <input
                type="radio"
                name="editor"
                checked={draft.editor.kind === e.kind}
                onChange={() => setDraft({ ...draft, editor: { kind: e.kind, ...(e.kind === 'custom' ? { command: draft.editor.command ?? '' } : {}) } })}
              />
              <span>{e.label}</span>
            </label>
          ))}
        </div>
        {draft.editor.kind === 'custom' ? (
          <label class="cockpit-picker__field">
            <span class="cockpit-muted">Command — {'{file}'}, {'{line}'} and {'{col}'} are filled in</span>
            <input
              value={draft.editor.command ?? ''}
              placeholder='subl "{file}:{line}:{col}"'
              spellcheck={false}
              onInput={(e) => setDraft({ ...draft, editor: { kind: 'custom', command: (e.target as HTMLInputElement).value } })}
            />
          </label>
        ) : null}
      </>
    ),
    notifications: (
      <>
        <p class="cockpit-muted">When a session waits for you, or its agent finishes, while you look elsewhere (another app, project or tab). These apply right away.</p>
        <label class="cockpit-settings__toggle" data-setting="notify-finish">
          <input type="checkbox" checked={notify.finish} onChange={(e) => onNotify({ ...notify, finish: (e.target as HTMLInputElement).checked })} />
          <span>Also when an agent finishes (it stopped working without asking)</span>
        </label>
        <label class="cockpit-settings__toggle" data-setting="notify-sound">
          <input type="checkbox" checked={notify.sound} onChange={(e) => onNotify({ ...notify, sound: (e.target as HTMLInputElement).checked })} />
          <span>Play a sound</span>
        </label>
        <label class="cockpit-settings__toggle" data-setting="notify-dock">
          <input type="checkbox" checked={notify.dockBadge} onChange={(e) => onNotify({ ...notify, dockBadge: (e.target as HTMLInputElement).checked })} />
          <span>Count them on the Dock icon</span>
        </label>
      </>
    ),
    voice: (
      <>
        <p class="cockpit-muted">
          Speak a prompt, read it in a draft under the stage, then send it to the focused pane. Nothing is sent without your Send.
          The programs below are yours: this app does not choose one. Audio stays on this Mac with a local transcribe command.
        </p>
        <label class="cockpit-picker__field" data-setting="voice-command">
          <span class="cockpit-muted">Transcribe command — one line; {'{audio}'} and {'{language}'} are filled in</span>
          <input class="cockpit-settings__command" value={draft.voice?.transcribeCommand ?? ''} spellcheck={false}
            placeholder="whisper-cli -m ~/models/ggml-large-v3-turbo.bin -f {audio} -l {language} -nt"
            onInput={(e) => setVoice({ transcribeCommand: (e.target as HTMLInputElement).value || undefined })} />
        </label>
        <label class="cockpit-picker__field" data-setting="voice-language">
          <span class="cockpit-muted">Spoken language</span>
          <select value={draft.voice?.language ?? 'auto'}
            onChange={(e) => setVoice({ language: (e.target as HTMLSelectElement).value === 'auto' ? undefined : (e.target as HTMLSelectElement).value as VoiceSettings['language'] })}>
            <option value="auto">Auto-detect</option>
            <option value="vi">Vietnamese</option>
            <option value="en">English</option>
          </select>
        </label>
        <label class="cockpit-picker__field" data-setting="voice-max">
          <span class="cockpit-muted">Longest recording, in seconds (5–1800)</span>
          <input type="number" min={5} max={1800} value={draft.voice?.maxSeconds ?? ''} placeholder="300"
            onInput={(e) => {
              const n = Number((e.target as HTMLInputElement).value)
              setVoice({ maxSeconds: Number.isInteger(n) && n > 0 ? n : undefined })
            }} />
        </label>
        <div class="cockpit-picker__field" data-setting="voice-test">
          <span class="cockpit-muted">Test — uses the saved command</span>
          <div class="cockpit-voice__test">
            <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={voiceTest.phase !== 'idle'} onClick={() => { void runVoiceTest() }}>
              {voiceTest.phase === 'recording' ? 'Listening… speak now' : voiceTest.phase === 'working' ? 'Transcribing…' : 'Record 3 seconds'}
            </button>
            {voiceTest.phase === 'recording' ? (
              <div class="cockpit-voice__meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(1, voiceTest.level ?? 0)}>
                <div style={{ width: `${Math.round(Math.min(1, (voiceTest.level ?? 0) * 4) * 100)}%` }} />
              </div>
            ) : null}
            {voiceTest.result !== undefined ? <p role="status">Heard: “{voiceTest.result}”</p> : null}
            {voiceTest.error !== undefined ? <p class="cockpit-error" role="alert">{voiceTest.error}</p> : null}
          </div>
        </div>
        <div data-setting="voice-snippets">
          <p class="cockpit-muted">Snippets — text added to the end of a draft with one click</p>
          <ul class="cockpit-voice__snippets">
            {snippets.map((sn, i) => (
              <li key={i}>
                <input value={sn.name} aria-label="Snippet name" placeholder="Name"
                  onInput={(e) => setSnippets(snippets.map((x, j) => (j === i ? { ...x, name: (e.target as HTMLInputElement).value } : x)))} />
                <input value={sn.text} aria-label="Snippet text" placeholder="Text added to the draft"
                  onInput={(e) => setSnippets(snippets.map((x, j) => (j === i ? { ...x, text: (e.target as HTMLInputElement).value } : x)))} />
                <button type="button" class="cockpit-iconbtn" aria-label={`Remove snippet ${sn.name}`} onClick={() => setSnippets(snippets.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
          </ul>
          <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={snippets.length >= 20}
            onClick={() => setSnippets([...snippets, { name: `Snippet ${snippets.length + 1}`, text: '' }])}>+ Add snippet</button>
        </div>
        <label class="cockpit-settings__toggle" data-setting="voice-refine">
          <input type="checkbox" checked={draft.voice?.refine?.enabled === true}
            onChange={(e) => setRefine({ enabled: (e.target as HTMLInputElement).checked ? true : undefined })} />
          <span>Refine the draft with a command (off by default). The draft is sent to the program below — whatever that program contacts receives it.</span>
        </label>
        {draft.voice?.refine?.enabled === true ? (
          <>
            <label class="cockpit-picker__field" data-setting="voice-refine-command">
              <span class="cockpit-muted">Refine command — reads the draft on stdin, prints the refined prompt</span>
              <input class="cockpit-settings__command" value={draft.voice?.refine?.command ?? ''} spellcheck={false} placeholder="claude -p"
                onInput={(e) => setRefine({ command: (e.target as HTMLInputElement).value })} />
            </label>
            <label class="cockpit-picker__field" data-setting="voice-refine-instruction">
              <span class="cockpit-muted">Instruction — empty uses the default that forbids adding requirements</span>
              <textarea rows={5} spellcheck={false} value={draft.voice?.refine?.instruction ?? ''} placeholder={DEFAULT_REFINE_INSTRUCTION}
                onInput={(e) => setRefine({ instruction: (e.target as HTMLTextAreaElement).value })} />
            </label>
            <label class="cockpit-settings__toggle" data-setting="voice-refine-auto">
              <input type="checkbox" checked={draft.voice?.refine?.auto === true}
                onChange={(e) => setRefine({ auto: (e.target as HTMLInputElement).checked ? true : undefined })} />
              <span>Refine right after each transcription (you still Accept or Revert)</span>
            </label>
            <label class="cockpit-settings__toggle" data-setting="voice-refine-context">
              <input type="checkbox" checked={draft.voice?.refine?.includeContext === true}
                onChange={(e) => setRefine({ includeContext: (e.target as HTMLInputElement).checked ? true : undefined })} />
              <span>Include the session's name and branch with the draft</span>
            </label>
          </>
        ) : null}
      </>
    ),
    usage: (
      <>
        <p class="cockpit-muted">
          Tokens the agents in each session have used, read from their own logs (Claude Code, Codex). The logs carry no
          prices — add yours (USD per million tokens) to see cost; a model without a price shows as tokens.
        </p>
        <label class="cockpit-settings__toggle" data-setting="usage-show">
          <input type="checkbox" checked={draft.usage?.show ?? true}
            onChange={(e) => setDraft({ ...draft, usage: { ...draft.usage, show: (e.target as HTMLInputElement).checked } })} />
          <span>Show usage on the rail</span>
        </label>
        <div data-setting="usage-prices">
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
        ) : <p class="cockpit-muted">No agent usage seen yet in the open projects.</p>}
        <div class="cockpit-prices__add">
          <input class="cockpit-field--mono" value={newModel} placeholder="another model, e.g. claude-opus-5-5" spellcheck={false}
            onInput={(e) => setNewModel((e.target as HTMLInputElement).value.trim())} />
          <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={newModel === '' || newModel in prices}
            onClick={() => { setPrice(newModel, 'input', '0'); setNewModel('') }}>Add model</button>
        </div>
        </div>
      </>
    ),
  }

  return (
    <div
      class="cockpit-settings-page"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onKeyDown={(e) => { if (e.key === 'Escape') void close() }}
    >
      <div class="cockpit-settings-page__top">
        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" onClick={() => { void close() }}>‹ Back</button>
        <h1 class="cockpit-settings-page__title">Settings</h1>
      </div>
      <div class="cockpit-settings-page__body">
        <nav class="cockpit-settings-nav" aria-label="Settings sections">
          <input class="cockpit-settings-nav__search" type="search" placeholder="Search settings" aria-label="Search settings" spellcheck={false}
            value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
          <ul>
            {SETTINGS_SECTIONS.map((s) => (
              <li key={s.id}>
                <button type="button" class={`cockpit-settings-nav__item${!searching && section === s.id ? ' is-active' : ''}`}
                  aria-current={!searching && section === s.id ? 'page' : undefined}
                  onClick={() => { setQuery(''); setSection(s.id) }}>{s.title}</button>
              </li>
            ))}
          </ul>
        </nav>
        <main class="cockpit-settings-content" ref={contentRef}>
          {notSaved !== null ? (
            <p class="cockpit-error cockpit-settings-content__unsaved" role="alert">Not saved — {notSaved}</p>
          ) : null}
          {error ? <p class="cockpit-error" role="alert">{error}</p> : null}
          {searching ? (
            hits.length === 0 ? <p class="cockpit-muted">No settings match “{query.trim()}”.</p> : (
              <div class="cockpit-settings-results">
                {hits.map((g) => (
                  <section key={g.section.id}>
                    <h2 class="cockpit-settings__heading">{g.section.title}</h2>
                    <ul>
                      {g.rows.map((r) => (
                        <li key={r.id}>
                          <button type="button" class="cockpit-settings-results__row"
                            onClick={() => { setQuery(''); setSection(g.section.id); setTarget(r.id) }}>
                            <span>{r.label}</span>
                            <span class="cockpit-muted">{r.description}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )
          ) : (
            <section>
              <h2 class="cockpit-settings__heading">{findSection(section)?.title}</h2>
              {bodies[section]}
            </section>
          )}
        </main>
      </div>
    </div>
  )
}
