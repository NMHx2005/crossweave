import { useState } from 'preact/hooks'
import { formatEnvLines, launcherIdFor, parseEnvLines } from '../lib/launchers'
import { AgentMark } from './icons'
import type { TerminalAppearance } from '../../../../src/core/settings.js'
import type { TerminalImport } from '../host/cockpit-api'
import { xtermLook } from '../lib/terminal-look'

export type EditorSetting = { kind: 'vscode' | 'cursor' | 'zed' | 'custom' | 'cockpit'; command?: string }
export type LauncherSetting = {
  id: string
  label: string
  command: string
  env: Record<string, string>
  enabled: boolean
  builtin: boolean
}
export type UserSettings = { launchers: LauncherSetting[]; editor: EditorSetting; layouts: Record<string, unknown>; terminal?: TerminalAppearance }

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
export type NotifyPrefs = { sound: boolean; dockBadge: boolean }

const TERMINAL_APPS: Array<{ id: 'ghostty' | 'iterm2'; label: string }> = [
  { id: 'ghostty', label: 'Ghostty' },
  { id: 'iterm2', label: 'iTerm2' },
]

export function SettingsPanel({ initial, availability, defaults, notify, onNotify, importSources, onImport, onSave, onClose }: {
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
  onSave: (next: UserSettings) => Promise<string | null>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<UserSettings>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  /** The env textarea as typed, per launcher, until it parses. */
  const [envText, setEnvText] = useState<Record<string, string>>({})
  /** What the last import said (a font not installed, a theme not found), or why it failed. */
  const [importNote, setImportNote] = useState<{ text: string; error: boolean } | null>(null)
  const [importing, setImporting] = useState<string | null>(null)

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

  const save = async (): Promise<void> => {
    // Every env box must parse before anything is sent.
    for (const [id, text] of Object.entries(envText)) {
      const parsed = parseEnvLines(text)
      if (!parsed.ok) {
        setOpen(id)
        setError(`${draft.launchers.find((l) => l.id === id)?.label ?? id}: ${parsed.error}`)
        return
      }
    }
    setSaving(true)
    const problem = await onSave(draft)
    setSaving(false)
    if (problem === null) onClose()
    else setError(problem)
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div
        class="cockpit-picker cockpit-settings"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      >
        <h2 class="cockpit-picker__title">Settings</h2>

        <h3 class="cockpit-settings__heading">Launchers</h3>
        <p class="cockpit-muted">
          What a new session can start with. The command is typed into the session's shell, in its
          worktree; when it exits you are back at the prompt. Your aliases and wrappers work (e.g. <code>cx</code>).
        </p>
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

        <h3 class="cockpit-settings__heading">Terminal</h3>
        <p class="cockpit-muted">
          How the panes look. Import from the terminal you use — font, size, colors, cursor and the Option key — then adjust.
        </p>
        <div class="cockpit-term__actions">
          {TERMINAL_APPS.map((app) => (
            <button key={app.id} type="button" class="cockpit-btn cockpit-btn--sm"
              disabled={!importSources[app.id] || importing !== null}
              title={importSources[app.id] ? `Read ${app.label}'s settings (nothing is saved until you press Save)` : `No ${app.label} settings found on this Mac`}
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
          <label class="cockpit-picker__field">
            <span class="cockpit-muted">Font</span>
            <input class="cockpit-field--mono" value={draft.terminal?.fontFamily ?? ''} placeholder="the cockpit's (Menlo)" spellcheck={false}
              onInput={(e) => setTerminal({ fontFamily: (e.target as HTMLInputElement).value.trim() || undefined })} />
          </label>
          <label class="cockpit-picker__field">
            <span class="cockpit-muted">Size</span>
            <input type="number" min={8} max={32} value={draft.terminal?.fontSize ?? ''} placeholder="13"
              onInput={(e) => {
                const n = Number((e.target as HTMLInputElement).value)
                setTerminal({ fontSize: Number.isInteger(n) && n > 0 ? n : undefined })
              }} />
          </label>
          <label class="cockpit-picker__field">
            <span class="cockpit-muted">Cursor</span>
            <select value={draft.terminal?.cursorStyle ?? 'block'}
              onChange={(e) => setTerminal({ cursorStyle: (e.target as HTMLSelectElement).value as TerminalAppearance['cursorStyle'] })}>
              <option value="block">Block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </select>
          </label>
        </div>
        <label class="cockpit-settings__toggle">
          <input type="checkbox" checked={draft.terminal?.cursorBlink ?? true} onChange={(e) => setTerminal({ cursorBlink: (e.target as HTMLInputElement).checked })} />
          <span>Blinking cursor</span>
        </label>
        <label class="cockpit-settings__toggle">
          <input type="checkbox" checked={draft.terminal?.optionAsMeta ?? false} onChange={(e) => setTerminal({ optionAsMeta: (e.target as HTMLInputElement).checked })} />
          <span>Option key sends Meta (Esc+), for Alt shortcuts in the shell and in agents</span>
        </label>

        <h3 class="cockpit-settings__heading">Cmd+click opens files in</h3>
        <div class="cockpit-settings__editors" role="radiogroup" aria-label="Editor">
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

        <h3 class="cockpit-settings__heading">When a session waits for you</h3>
        <p class="cockpit-muted">A desktop notification when the window is not in front; these apply right away.</p>
        <label class="cockpit-settings__toggle">
          <input type="checkbox" checked={notify.sound} onChange={(e) => onNotify({ ...notify, sound: (e.target as HTMLInputElement).checked })} />
          <span>Play a sound</span>
        </label>
        <label class="cockpit-settings__toggle">
          <input type="checkbox" checked={notify.dockBadge} onChange={(e) => onNotify({ ...notify, dockBadge: (e.target as HTMLInputElement).checked })} />
          <span>Count them on the Dock icon</span>
        </label>

        {error ? <p class="cockpit-error" role="alert">{error}</p> : null}
        <div class="cockpit-picker__actions">
          <button type="button" class="cockpit-btn" onClick={onClose}>Cancel</button>
          <button type="button" class="cockpit-btn cockpit-btn--primary" disabled={saving} onClick={() => { void save() }}>Save</button>
        </div>
      </div>
    </div>
  )
}
