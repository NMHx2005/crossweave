import { useState } from 'preact/hooks'
import type { FolderInfo } from '../../electron/folder-open'

/**
 * A folder that is not a repository's top level, chosen to open. It used to fail after
 * ten seconds with "Daemon did not come up"; now it says what the folder is and offers
 * the ways forward: a repository inside it (a folder of projects), the repository it
 * sits in, `git init`, or opening it as a plain folder.
 */
export function OpenFolderDialog({ path, info, onOpen, onInitGit, onOpenPlain, onClose }: {
  path: string
  info: FolderInfo
  /** Open a repository (one inside, or the one this folder is in). */
  onOpen: (root: string) => Promise<void>
  /** Confirmed by the host first; the result's words, or null when cancelled. */
  onInitGit: () => Promise<string | null>
  /** Open as a plain folder: sessions in the folder only, no worktrees. */
  onOpenPlain?: () => void
  onClose: () => void
}) {
  const [opened, setOpened] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const name = baseName(path)

  const open = async (root: string): Promise<void> => {
    setBusy(true)
    await onOpen(root)
    setBusy(false)
    setOpened((list) => [...list, root])
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div class="cockpit-picker cockpit-open-folder" role="dialog" aria-label={`Open ${name}`}
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <h2 class="cockpit-picker__title">
          {info.kind === 'inside-repo' ? `“${name}” is inside a git repository` : info.kind === 'missing' ? `“${name}” is not there any more` : `“${name}” is not a git repository`}
        </h2>

        {info.kind === 'inside-repo' ? (
          <>
            <p class="cockpit-muted">A project is a whole repository: its sessions branch from it. Open the repository this folder belongs to.</p>
            <div class="cockpit-picker__actions">
              <button type="button" class="cockpit-btn" onClick={onClose}>Cancel</button>
              <button type="button" class="cockpit-btn cockpit-btn--primary" disabled={busy}
                onClick={() => { void open(info.repoRoot).then(onClose) }}>Open “{baseName(info.repoRoot)}”</button>
            </div>
          </>
        ) : info.kind === 'missing' ? (
          <div class="cockpit-picker__actions">
            <button type="button" class="cockpit-btn cockpit-btn--primary" onClick={onClose}>Close</button>
          </div>
        ) : (
          <>
            <p class="cockpit-muted">
              crossweave gives each session its own git worktree, so a project is a git repository.
              {info.repos.length > 0 ? ' This folder holds some — open one or several:' : ''}
            </p>
            {info.repos.length > 0 ? (
              <ul class="cockpit-open-folder__repos" aria-label="Git repositories inside">
                {info.repos.map((repo) => (
                  <li key={repo}>
                    <span class="cockpit-open-folder__name" title={repo}>{baseName(repo)}</span>
                    <span class="cockpit-muted cockpit-open-folder__path">{relative(path, repo) === baseName(repo) ? '' : relative(path, repo)}</span>
                    {opened.includes(repo)
                      ? <span class="cockpit-open-folder__done">Opened</span>
                      : <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={busy} onClick={() => { void open(repo) }}>Open</button>}
                  </li>
                ))}
              </ul>
            ) : null}
            {note !== null ? <p class="cockpit-muted" role="status">{note}</p> : null}
            <div class="cockpit-picker__actions">
              <button type="button" class="cockpit-btn" onClick={onClose}>{opened.length > 0 ? 'Done' : 'Cancel'}</button>
              {onOpenPlain ? (
                <button type="button" class="cockpit-btn" disabled={busy} title="Sessions in this folder only: no worktrees, Land or diff"
                  onClick={onOpenPlain}>Open as a plain folder</button>
              ) : null}
              {/* A folder of projects is rarely meant to become one repository itself. */}
              <button type="button" class={`cockpit-btn${info.repos.length === 0 ? ' cockpit-btn--primary' : ''}`} disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void onInitGit().then((said) => {
                    setBusy(false)
                    if (said !== null) setNote(said)
                  })
                }}>Initialize git here…</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

/** `repo` below `parent`, as shown under its name: "Client/shop". */
function relative(parent: string, repo: string): string {
  const p = parent.replace(/\/+$/, '')
  return repo.startsWith(`${p}/`) ? repo.slice(p.length + 1) : repo
}
