import { describe, expect, test } from 'bun:test'
import { refine, resolveCommand, type RefineDeps } from '../electron/prompt-refine'
import { DEFAULT_REFINE_INSTRUCTION } from '../src/lib/prompt-defaults'

type Call = { command: string; args: string[]; input: string; timeoutMs: number }

function deps(over: Partial<RefineDeps> & { prompt?: ReturnType<RefineDeps['loadPrompt']> } = {}): { d: RefineDeps; calls: Call[] } {
  const calls: Call[] = []
  const d: RefineDeps = {
    home: '/home/u',
    loadPrompt: () => ('prompt' in over ? over.prompt : { refine: { command: 'claude -p' } }),
    run: async (command, args, opts) => { calls.push({ command, args, input: opts.input, timeoutMs: opts.timeoutMs }); return { code: 0, stdout: '  Refined prompt\n', stderr: '' } },
    ...(over.resolveCommand === undefined ? {} : { resolveCommand: over.resolveCommand }),
    ...(over.run === undefined ? {} : { run: over.run }),
  }
  return { d, calls }
}

describe('refine', () => {
  test('runs the saved command with the instruction and the draft on stdin, and returns its output trimmed', async () => {
    const { d, calls } = deps()
    expect(await refine(d, { text: 'fix the bug in login' })).toEqual({ ok: true, text: 'Refined prompt' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('claude')
    expect(calls[0]?.args).toEqual(['-p'])
    expect(calls[0]?.input).toContain(DEFAULT_REFINE_INSTRUCTION)
    expect(calls[0]?.input).toContain('--- draft prompt ---\nfix the bug in login')
  })

  test('a refine aborted while the command runs comes back cancelled, not as a failure to word', async () => {
    const controller = new AbortController()
    const { d } = deps({
      run: (_command, _args, opts) => new Promise((resolve) => {
        opts.signal.addEventListener('abort', () => resolve({ code: 124, stdout: '', stderr: 'terminated' }))
      }),
    })
    const pending = refine(d, { text: 'x' }, controller.signal)
    controller.abort()
    expect(await pending).toEqual({ ok: false, reason: 'Cancelled.', cancelled: true })
  })

  test('a signal already aborted runs nothing, and a command that throws after an abort is still just cancelled', async () => {
    const gone = new AbortController()
    gone.abort()
    const first = deps()
    expect(await refine(first.d, { text: 'x' }, gone.signal)).toMatchObject({ ok: false, cancelled: true })
    expect(first.calls).toHaveLength(0)

    const late = new AbortController()
    const second = deps({ run: async () => { late.abort(); throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }) } })
    expect(await refine(second.d, { text: 'x' }, late.signal)).toMatchObject({ ok: false, cancelled: true })
  })

  test('an output that arrives after the abort is dropped, not offered as a proposal', async () => {
    const controller = new AbortController()
    const { d } = deps({ run: async () => { controller.abort(); return { code: 0, stdout: 'too late', stderr: '' } } })
    expect(await refine(d, { text: 'x' }, controller.signal)).toMatchObject({ ok: false, cancelled: true })
  })

  test('without a command there is nothing to run, and nothing is run', async () => {
    for (const prompt of [undefined, {}, { refine: {} }, { refine: { command: '   ' } }]) {
      const { d, calls } = deps({ prompt })
      const r = await refine(d, { text: 'x' })
      expect(r).toMatchObject({ ok: false })
      expect(calls).toHaveLength(0)
    }
  })

  test('an empty or over-long draft is refused before anything runs', async () => {
    const { d, calls } = deps()
    expect(await refine(d, { text: '   ' })).toMatchObject({ ok: false })
    expect(await refine(d, { text: 'x'.repeat(100_001) })).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })

  test("the user's own instruction replaces the default", async () => {
    const { d, calls } = deps({ prompt: { refine: { command: 'llm', instruction: 'Be terse.' } } })
    await refine(d, { text: 'x' })
    expect(calls[0]?.input.startsWith('Be terse.')).toBe(true)
    expect(calls[0]?.input).not.toContain(DEFAULT_REFINE_INSTRUCTION)
  })

  test('session context reaches the command only when the user switched it on', async () => {
    const off = deps({ prompt: { refine: { command: 'llm' } } })
    await refine(off.d, { text: 'x', context: 'branch: cw/a' })
    expect(off.calls[0]?.input).not.toContain('branch: cw/a')
    const on = deps({ prompt: { refine: { command: 'llm', includeContext: true } } })
    await refine(on.d, { text: 'x', context: 'branch: cw/a' })
    expect(on.calls[0]?.input).toContain('branch: cw/a')
  })

  test('the command line is split into words, not handed to a shell: ~ is the home, quotes group, a semicolon is just text', async () => {
    const { d, calls } = deps({ prompt: { refine: { command: 'llm --model "big one" ~/prompts/x.md; echo hi' } } })
    await refine(d, { text: 'x' })
    expect(calls[0]?.command).toBe('llm')
    expect(calls[0]?.args).toEqual(['--model', 'big one', '/home/u/prompts/x.md;', 'echo', 'hi'])
  })

  test('a program that is not installed, cannot start, exits non-zero or prints nothing says so in words', async () => {
    expect(await refine(deps({ resolveCommand: async () => undefined }).d, { text: 'x' })).toMatchObject({ ok: false, reason: expect.stringContaining('Command not found: claude') })
    const enoent = Object.assign(new Error('spawn'), { code: 'ENOENT' })
    expect(await refine(deps({ run: async () => { throw enoent } }).d, { text: 'x' })).toMatchObject({ ok: false, reason: expect.stringContaining('Command not found') })
    expect(await refine(deps({ run: async () => ({ code: 2, stdout: '', stderr: 'rate limited\n' }) }).d, { text: 'x' })).toMatchObject({ ok: false, reason: 'claude exited with status 2: rate limited' })
    expect(await refine(deps({ run: async () => ({ code: 0, stdout: '  \n', stderr: '' }) }).d, { text: 'x' })).toMatchObject({ ok: false, reason: 'The refine command returned nothing.' })
  })

  test('an unbalanced quote in the saved command is a message, not a crash', async () => {
    const { d, calls } = deps({ prompt: { refine: { command: 'llm "oops' } } })
    expect(await refine(d, { text: 'x' })).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })
})

describe('resolveCommand', () => {
  const base = { home: '/home/u', pathEnv: '/usr/bin:/bin', loginPath: async () => undefined as string | undefined }

  test('a path is used as it is', async () => {
    expect(await resolveCommand('/opt/x/llm', { ...base, isExecutable: () => false })).toBe('/opt/x/llm')
  })

  test("looks in the app's PATH, then the usual bin directories, then the login shell's PATH", async () => {
    expect(await resolveCommand('llm', { ...base, isExecutable: (p) => p === '/bin/llm' })).toBe('/bin/llm')
    expect(await resolveCommand('llm', { ...base, isExecutable: (p) => p === '/opt/homebrew/bin/llm' })).toBe('/opt/homebrew/bin/llm')
    expect(await resolveCommand('llm', { ...base, loginPath: async () => '/somewhere/bin', isExecutable: (p) => p === '/somewhere/bin/llm' })).toBe('/somewhere/bin/llm')
    expect(await resolveCommand('llm', { ...base, isExecutable: () => false })).toBeUndefined()
  })

  test('the login shell is only asked when the cheaper places failed', async () => {
    let asked = 0
    await resolveCommand('llm', { ...base, isExecutable: (p) => p === '/bin/llm', loginPath: async () => { asked++; return undefined } })
    expect(asked).toBe(0)
  })
})
