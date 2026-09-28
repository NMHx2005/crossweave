import { describe, expect, test } from 'bun:test'
import { initGit, inspectFolder, type FolderDeps, type Run } from '../electron/folder-open'
import type { FolderKind } from '../../../src/core/folder-kind.js'

const deps = (kind: FolderKind, repos: string[] = []): FolderDeps => ({ kind: () => kind, findRepos: () => repos })

describe('inspectFolder', () => {
  test('lists the repositories inside a plain folder', () => {
    expect(inspectFolder('/work/Win', deps({ kind: 'plain' }, ['/work/Win/a']))).toEqual({ kind: 'plain', repos: ['/work/Win/a'] })
  })
  test('points a subfolder to its repository, and searches nothing else', () => {
    let searched = false
    const info = inspectFolder('/r/src', { kind: () => ({ kind: 'inside-repo', repoRoot: '/r' }), findRepos: () => { searched = true; return [] } })
    expect(info).toEqual({ kind: 'inside-repo', repoRoot: '/r', repos: [] })
    expect(searched).toBe(false)
  })
  test('refuses what is not an absolute path', () => {
    for (const bad of [undefined, 12, 'relative/dir', '']) expect(inspectFolder(bad, deps({ kind: 'repo' })).kind).toBe('missing')
  })
})

function runner(answers: Record<string, { ok: boolean; out?: string }>) {
  const calls: string[] = []
  const run: Run = async (command, args) => {
    const key = `${command} ${args.join(' ')}`
    calls.push(key)
    const a = Object.entries(answers).find(([k]) => key.startsWith(k))?.[1] ?? { ok: true, out: '' }
    return { ok: a.ok, out: a.out ?? '' }
  }
  return { run, calls }
}

describe('initGit', () => {
  test('inits and makes an empty first commit when git knows the user', async () => {
    const r = runner({ 'git config user.name': { ok: true, out: 'Hung\n' }, 'git config user.email': { ok: true, out: 'h@x\n' } })
    const out = await initGit('/work/Win', { ...deps({ kind: 'plain' }), run: r.run })
    expect(out).toMatchObject({ ok: true, committed: true })
    expect(r.calls).toEqual(['git init -q', 'git config user.name', 'git config user.email', 'git commit -q --allow-empty -m Initial commit'])
  })
  test('inits without a commit, and says why, when git does not know the user', async () => {
    const r = runner({ 'git config user.name': { ok: false, out: '' } })
    const out = await initGit('/work/Win', { ...deps({ kind: 'plain' }), run: r.run })
    expect(out).toMatchObject({ ok: true, committed: false })
    expect(out.message).toMatch(/user\.name/)
    expect(r.calls).not.toContain('git commit -q --allow-empty -m Initial commit')
  })
  test('never touches a repository, a subfolder of one, or a bad path', async () => {
    for (const kind of [{ kind: 'repo' }, { kind: 'inside-repo', repoRoot: '/r' }, { kind: 'missing' }] as FolderKind[]) {
      const r = runner({})
      expect((await initGit('/x', { ...deps(kind), run: r.run })).ok).toBe(false)
      expect(r.calls).toEqual([])
    }
    const r = runner({})
    expect((await initGit('rel', { ...deps({ kind: 'plain' }), run: r.run })).ok).toBe(false)
  })
})
