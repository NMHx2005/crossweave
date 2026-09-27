import { useState } from 'preact/hooks'
import type { LauncherOption } from '../host/cockpit-api'
import { SESSION_COLORS } from '../lib/colors'
import type { ProjectPrefs } from '../lib/project-prefs'

/**
 * One project's own settings: what the rail calls it and its color (this window only —
 * the folder is never renamed), and what a new session there starts as. Saved per
 * viewer, like the rail's other view preferences.
 */
export function ProjectSettings({ projectRoot, folderName, initial, launchers, branches, onSave, onClose }: {
  projectRoot: string
  folderName: string
  initial: ProjectPrefs
  launchers: LauncherOption[]
  /** The project's branches when it is on the stage; otherwise the base is typed. */
  branches: string[]
  onSave: (prefs: ProjectPrefs) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState(initial.label ?? '')
  const [color, setColor] = useState(initial.color)
  const [launcher, setLauncher] = useState(initial.launcher ?? '')
  const [worktree, setWorktree] = useState(initial.worktree === true)
  const [base, setBase] = useState(initial.base ?? '')
  const [hideEnded, setHideEnded] = useState(initial.hideEnded === true)
  const usable = launchers.filter((l) => l.enabled)

  const save = (): void => {
    onSave({
      ...(label.trim() === '' ? {} : { label: label.trim() }),
      ...(color === undefined ? {} : { color }),
      ...(launcher === '' ? {} : { launcher }),
      ...(worktree ? { worktree: true } : {}),
      ...(worktree && base.trim() !== '' ? { base: base.trim() } : {}),
      ...(hideEnded ? { hideEnded: true } : {}),
    })
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div
        class="cockpit-picker cockpit-project-settings"
        role="dialog"
        aria-label={`Project settings — ${folderName}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.isComposing) return
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
        }}
      >
        <h2 class="cockpit-picker__title">Project settings</h2>
        <p class="cockpit-muted cockpit-project-settings__path" title={projectRoot}>{projectRoot}</p>

        <h3 class="cockpit-settings__heading">In the rail</h3>
        <label class="cockpit-picker__field">
          <span class="cockpit-muted">Display name — only this app; the folder keeps its name</span>
          <input value={label} placeholder={folderName} maxLength={60} spellcheck={false}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
        </label>
        <div class="cockpit-picker__field">
          <span class="cockpit-muted">Color</span>
          <div class="cockpit-menu__swatches" role="radiogroup" aria-label="Project color">
            {SESSION_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c}
                class={`cockpit-swatch${color === c ? ' is-selected' : ''}`} style={{ background: `var(--cw-${c})` }}
                onClick={() => setColor(c)} />
            ))}
            <button type="button" role="radio" aria-checked={color === undefined} aria-label="No color"
              class={`cockpit-swatch cockpit-swatch--none${color === undefined ? ' is-selected' : ''}`}
              onClick={() => setColor(undefined)} />
          </div>
        </div>
        <label class="cockpit-picker__check">
          <input type="checkbox" checked={hideEnded} onChange={(e) => setHideEnded((e.target as HTMLInputElement).checked)} />
          <span>Hide ended (killed) sessions</span>
        </label>

        <h3 class="cockpit-settings__heading">New sessions</h3>
        <label class="cockpit-picker__field">
          <span class="cockpit-muted">Start with</span>
          <select value={launcher} onChange={(e) => setLauncher((e.target as HTMLSelectElement).value)}>
            <option value="">the last one used</option>
            <option value="terminal">Terminal</option>
            {usable.map((l) => (
              <option key={l.id} value={l.id}>{l.label}{l.available ? '' : ' (not installed)'}</option>
            ))}
          </select>
        </label>
        <label class="cockpit-picker__check">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree((e.target as HTMLInputElement).checked)} />
          <span>Own worktree by default. Off: sessions work in the project folder itself.</span>
        </label>
        <label class="cockpit-picker__field">
          <span class="cockpit-muted">Worktrees start from</span>
          <input class="cockpit-field--mono" value={base} list="cw-project-branches" placeholder="current HEAD" disabled={!worktree} spellcheck={false}
            onInput={(e) => setBase((e.target as HTMLInputElement).value)} />
          <datalist id="cw-project-branches">
            {branches.map((b) => <option key={b} value={b} />)}
          </datalist>
        </label>

        <div class="cockpit-picker__actions">
          <button type="button" class="cockpit-btn" onClick={onClose}>Cancel</button>
          <button type="button" class="cockpit-btn cockpit-btn--primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
