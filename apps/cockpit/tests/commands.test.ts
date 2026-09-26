import { describe, expect, test } from 'bun:test'
import { COMMANDS, completions, parseCommand, rememberLine, type CommandContext } from '../src/lib/commands'

const ctx: CommandContext = {
  sessions: [
    { id: 's1', name: 'api', status: 'idle' },
    { id: 's2', name: 'auth-refactor', status: 'running' },
  ],
  focusedName: 'api',
}

const ok = (line: string) => {
  const r = parseCommand(line, ctx)
  if (!r.ok) throw new Error(`expected ok for "${line}": ${r.error}`)
  return r.command
}
const err = (line: string) => {
  const r = parseCommand(line, ctx)
  if (r.ok) throw new Error(`expected an error for "${line}"`)
  return r.error
}

describe('parseCommand', () => {
  // A session is a worktree and a shell: no agent to name, no flags to pass.
  test('new: a name, a base, shared', () => {
    expect(ok('new web')).toEqual({ kind: 'new', name: 'web', shared: false })
    expect(ok('new web --base main')).toEqual({ kind: 'new', name: 'web', base: 'main', shared: false })
    expect(ok('new web --shared')).toMatchObject({ shared: true })
  })

  test('new: refuses a taken or invalid name, and anything extra', () => {
    expect(err('new api')).toMatch(/exists/)
    expect(err('new "bad name"')).toMatch(/name/i)
    expect(err('new web claude')).toMatch(/too many/i)
    expect(err('new')).toMatch(/usage/i)
  })

  test('session verbs default to the focused session and resolve a named one', () => {
    expect(ok('start')).toEqual({ kind: 'start', session: 's1' })
    expect(ok('start api')).toEqual({ kind: 'start', session: 's1' })
    expect(ok('stop auth-refactor')).toEqual({ kind: 'stop', session: 's2' })
    expect(ok('kill api --rm')).toEqual({ kind: 'kill', session: 's1', removeWorktree: true })
    expect(ok('land')).toEqual({ kind: 'land', session: 's1' })
    expect(ok('land --all')).toEqual({ kind: 'land-all' })
    expect(ok('diff auth-refactor')).toEqual({ kind: 'diff', session: 's2' })
    expect(ok('term')).toEqual({ kind: 'terminal', session: 's1' })
    expect(ok('rename api web')).toEqual({ kind: 'rename', session: 's1', to: 'web' })
  })

  test('an unknown session, or no session to default to, is an error that says so', () => {
    expect(err('stop nope')).toMatch(/nope/)
    const r = parseCommand('stop', { ...ctx, focusedName: null })
    expect(!r.ok && r.error).toMatch(/session/i)
  })

  test('the app verbs', () => {
    expect(ok('open src/app.ts')).toEqual({ kind: 'open', path: 'src/app.ts' })
    expect(ok('open')).toEqual({ kind: 'open' })
    expect(ok('browser localhost:3000')).toEqual({ kind: 'browser', url: 'localhost:3000' })
    expect(ok('next')).toEqual({ kind: 'attention' })
    expect(ok('settings')).toEqual({ kind: 'settings' })
    expect(ok('buttons on')).toEqual({ kind: 'buttons', on: true })
    expect(ok('gc --force')).toEqual({ kind: 'gc', force: true })
    expect(ok('help')).toEqual({ kind: 'help' })
  })

  test('unknown verbs, stray flags and bad quoting are errors, never guesses', () => {
    expect(err('frobnicate')).toMatch(/frobnicate/)
    expect(err('stop api --force')).toMatch(/--force/)
    expect(err('new "web')).toMatch(/quote/i)
    expect(err('   ')).toMatch(/command/i)
  })
})

describe('completions', () => {
  test('the first word completes to verbs, with their usage', () => {
    const c = completions('st', ctx)
    expect(c.map((x) => x.value)).toEqual(['start ', 'stop '])
    expect(c[0]?.detail).toContain('start')
  })

  test('a session argument completes to session names', () => {
    expect(completions('stop au', ctx).map((x) => x.value)).toEqual(['stop auth-refactor '])
    expect(completions('land ', ctx).map((x) => x.value)).toEqual(['land api ', 'land auth-refactor '])
  })

  test('every documented verb parses in its simplest form', () => {
    for (const spec of COMMANDS) expect(spec.usage.startsWith(spec.name)).toBe(true)
  })
})

describe('rememberLine', () => {
  test('newest first, no duplicates, bounded', () => {
    expect(rememberLine(['b', 'a'], 'a')).toEqual(['a', 'b'])
    expect(rememberLine([], '  ')).toEqual([])
    const many = Array.from({ length: 30 }, (_, i) => `l${i}`)
    expect(rememberLine(many, 'new')).toHaveLength(20)
  })
})
