import { isAbsolute } from 'node:path'
import type { FolderKind } from '../../../src/core/folder-kind.js'

/** What the Open folder dialog is told about a folder that is not a repository's top level. */
export type FolderInfo = FolderKind & { repos: string[] }

export type FolderDeps = {
  kind: (path: string) => FolderKind
  findRepos: (path: string) => string[]
}

/**
 * A folder the user chose, described for the renderer: a repository opens as usual;
 * anything else gets the dialog — with the repositories found beneath a plain folder
 * (a folder that holds projects, like `work/Win`).
 */
export function inspectFolder(path: unknown, deps: FolderDeps): FolderInfo {
  if (typeof path !== 'string' || !isAbsolute(path)) return { kind: 'missing', repos: [] }
  const kind = deps.kind(path)
  return { ...kind, repos: kind.kind === 'plain' ? deps.findRepos(path) : [] }
}

export type Run = (command: string, args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>

/**
 * `git init` in a plain folder the user confirmed, then an empty first commit when git
 * knows who the user is — a session's worktree needs a commit to branch from. Argv only;
 * refused anywhere but a plain folder, so it can never re-init a repository.
 */
export async function initGit(path: unknown, deps: FolderDeps & { run: Run }): Promise<{ ok: boolean; committed: boolean; message: string }> {
  if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, committed: false, message: 'Not a folder' }
  if (deps.kind(path).kind !== 'plain') return { ok: false, committed: false, message: 'That folder is already in a git repository' }
  const init = await deps.run('git', ['init', '-q'], path)
  if (!init.ok) return { ok: false, committed: false, message: 'git init failed in that folder' }
  const name = (await deps.run('git', ['config', 'user.name'], path)).out.trim()
  const email = (await deps.run('git', ['config', 'user.email'], path)).out.trim()
  if (name === '' || email === '') {
    return { ok: true, committed: false, message: 'Git is set up. Set your git name and email (git config --global user.name / user.email) and make a first commit to start sessions in their own worktree.' }
  }
  const commit = await deps.run('git', ['commit', '-q', '--allow-empty', '-m', 'Initial commit'], path)
  return commit.ok
    ? { ok: true, committed: true, message: 'Git is set up, with an empty first commit.' }
    : { ok: true, committed: false, message: 'Git is set up, but the first commit failed — make one to start sessions in their own worktree.' }
}
