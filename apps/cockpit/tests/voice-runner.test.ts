import { describe, expect, test } from 'bun:test'
import { buildTranscribeArgv, cleanTranscript, refine, resolveCommand, transcribe, type RunResult, type VoiceDeps } from '../electron/voice'
import { DEFAULT_REFINE_INSTRUCTION } from '../src/lib/voice-defaults'

const HOME = '/Users/me'

describe('buildTranscribeArgv', () => {
  test('splits the line into arguments and fills {audio} and {language} as whole arguments', () => {
    const r = buildTranscribeArgv('whisper-cli -m ~/models/ggml.bin -f {audio} -l {language} -nt', { audio: '/tmp/a b/x.wav', language: 'vi' }, HOME)
    expect(r).toEqual({ command: 'whisper-cli', args: ['-m', '/Users/me/models/ggml.bin', '-f', '/tmp/a b/x.wav', '-l', 'vi', '-nt'] })
  })

  test('a placeholder inside a word is filled in place', () => {
    const r = buildTranscribeArgv('tool --input={audio}', { audio: '/tmp/x.wav', language: 'en' }, HOME)
    expect(r.args).toEqual(['--input=/tmp/x.wav'])
  })

  test('nothing in a path or language can be read as shell syntax: it stays one argument', () => {
    const hostile = '/tmp/$(danger);`x` "q".wav'
    const r = buildTranscribeArgv('tool {audio} {language}', { audio: hostile, language: 'auto' }, HOME)
    expect(r.args).toEqual([hostile, 'auto'])
  })

  test('a command without {audio} is refused: it could never hear the recording', () => {
    expect(() => buildTranscribeArgv('whisper-cli -nt', { audio: '/tmp/x.wav', language: 'en' }, HOME)).toThrow(/\{audio\}/)
  })

  test('an empty command says where to set it', () => {
    expect(() => buildTranscribeArgv('   ', { audio: '/tmp/x.wav', language: 'en' }, HOME)).toThrow(/Settings/)
  })

  test('an unknown placeholder is refused rather than sent literally', () => {
    expect(() => buildTranscribeArgv('tool {audio} {model}', { audio: '/tmp/x.wav', language: 'en' }, HOME)).toThrow(/\{model\}/)
  })

  test('quoted arguments with spaces survive', () => {
    const r = buildTranscribeArgv('tool -m "/My Models/a.bin" -f {audio}', { audio: '/t/x.wav', language: 'en' }, HOME)
    expect(r.args).toEqual(['-m', '/My Models/a.bin', '-f', '/t/x.wav'])
  })
})

describe('cleanTranscript', () => {
  test('joins lines, trims, and drops whisper markers for silence', () => {
    expect(cleanTranscript('  Hello there.\n  How are you? \n')).toBe('Hello there. How are you?')
    expect(cleanTranscript(' [BLANK_AUDIO]\n')).toBe('')
    expect(cleanTranscript('[BLANK_AUDIO] hi')).toBe('hi')
    expect(cleanTranscript('\n\n')).toBe('')
  })
})

function deps(over: Partial<VoiceDeps> & { result?: RunResult } = {}) {
  const calls: Array<{ command: string; args: string[]; input?: string }> = []
  const cleaned: string[] = []
  const d: VoiceDeps = {
    home: HOME,
    loadVoice: () => ({ transcribeCommand: 'whisper-cli -f {audio} -l {language}', language: 'vi', refine: { enabled: true, command: 'claude -p' } }),
    writeAudio: async () => ({ path: '/tmp/cw/x.wav', cleanup: async () => { cleaned.push('x') } }),
    run: async (command, args, opts) => {
      calls.push({ command, args, ...(opts.input === undefined ? {} : { input: opts.input }) })
      return over.result ?? { code: 0, stdout: ' hello world\n', stderr: '' }
    },
    ...over,
  }
  return { d, calls, cleaned }
}

describe('transcribe', () => {
  test('runs the user command on the recording and returns the cleaned text', async () => {
    const { d, calls } = deps()
    const r = await transcribe(d, new Uint8Array([1, 2, 3]))
    expect(r).toEqual({ ok: true, text: 'hello world' })
    expect(calls[0]).toEqual({ command: 'whisper-cli', args: ['-f', '/tmp/cw/x.wav', '-l', 'vi'] })
  })

  test('the recording is deleted whatever happens', async () => {
    for (const result of [{ code: 0, stdout: 'ok', stderr: '' }, { code: 1, stdout: '', stderr: 'boom' }]) {
      const { d, cleaned } = deps({ result })
      await transcribe(d, new Uint8Array([1]))
      expect(cleaned).toEqual(['x'])
    }
    const { d, cleaned } = deps({ run: async () => { throw new Error('spawn failed') } })
    await transcribe(d, new Uint8Array([1]))
    expect(cleaned).toEqual(['x'])
  })

  test('language defaults to auto when unset', async () => {
    const { d, calls } = deps({ loadVoice: () => ({ transcribeCommand: 'w {audio} {language}' }) })
    await transcribe(d, new Uint8Array([1]))
    expect(calls[0]!.args).toEqual(['/tmp/cw/x.wav', 'auto'])
  })

  test('no command configured: says where to set it, runs nothing', async () => {
    const { d, calls } = deps({ loadVoice: () => undefined })
    const r = await transcribe(d, new Uint8Array([1]))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/Settings → Voice/)
    expect(calls).toEqual([])
  })

  test("a non-zero exit reports the tool's own last line", async () => {
    const { d } = deps({ result: { code: 2, stdout: '', stderr: 'loading model\nerror: model not found\n' } })
    const r = await transcribe(d, new Uint8Array([1]))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('model not found')
  })

  test('nothing heard: reported, not returned as empty text', async () => {
    const { d } = deps({ result: { code: 0, stdout: ' [BLANK_AUDIO]\n', stderr: '' } })
    const r = await transcribe(d, new Uint8Array([1]))
    expect(r).toEqual({ ok: false, reason: 'Nothing was heard.' })
  })

  test('a command that cannot start (not installed) is a sentence, not a stack', async () => {
    const { d } = deps({ run: async () => { throw Object.assign(new Error('spawn whisper-cli ENOENT'), { code: 'ENOENT' }) } })
    const r = await transcribe(d, new Uint8Array([1]))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/not found|could not start/i)
    expect(r.ok === false && r.reason).not.toContain('at ')
  })

  test('an empty recording is refused before anything runs', async () => {
    const { d, calls } = deps()
    const r = await transcribe(d, new Uint8Array([]))
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('refine', () => {
  test('is unavailable while its switch is off, and runs nothing', async () => {
    const { d, calls } = deps({ loadVoice: () => ({ refine: { enabled: false, command: 'claude -p' } }) })
    const r = await refine(d, { text: 'fix the bug' })
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('sends the instruction and the draft on stdin, and returns the output', async () => {
    const { d, calls } = deps({ result: { code: 0, stdout: '# Objective\nFix the bug\n', stderr: '' } })
    const r = await refine(d, { text: 'fix the bug' })
    expect(r).toEqual({ ok: true, text: '# Objective\nFix the bug' })
    expect(calls[0]!.command).toBe('claude')
    expect(calls[0]!.args).toEqual(['-p'])
    expect(calls[0]!.input).toContain(DEFAULT_REFINE_INSTRUCTION)
    expect(calls[0]!.input).toContain('fix the bug')
  })

  test('a custom instruction replaces the default', async () => {
    const { d, calls } = deps({ loadVoice: () => ({ refine: { enabled: true, command: 'x', instruction: 'MY RULES' } }) })
    await refine(d, { text: 't' })
    expect(calls[0]!.input).toContain('MY RULES')
    expect(calls[0]!.input).not.toContain(DEFAULT_REFINE_INSTRUCTION)
  })

  test('session context is included only when asked for, and only what was passed', async () => {
    const on = deps({ loadVoice: () => ({ refine: { enabled: true, command: 'x', includeContext: true } }) })
    await refine(on.d, { text: 't', context: 'branch: cw/a\nchanged: src/x.ts' })
    expect(on.calls[0]!.input).toContain('branch: cw/a')
    const off = deps()
    await refine(off.d, { text: 't', context: 'branch: cw/a' })
    expect(off.calls[0]!.input).not.toContain('branch: cw/a')
  })

  test('no refine command: says where to set it', async () => {
    const { d } = deps({ loadVoice: () => ({ refine: { enabled: true } }) })
    const r = await refine(d, { text: 't' })
    expect(r.ok === false && r.reason).toMatch(/Settings → Voice/)
  })

  test('empty output is an error, and the draft is never replaced by it', async () => {
    const { d } = deps({ result: { code: 0, stdout: '  \n', stderr: '' } })
    const r = await refine(d, { text: 't' })
    expect(r.ok).toBe(false)
  })

  test('an empty draft is not sent anywhere', async () => {
    const { d, calls } = deps()
    const r = await refine(d, { text: '   ' })
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('resolveCommand', () => {
  const HOME2 = '/Users/me'
  const installed = new Set(['/opt/homebrew/bin/whisper-cli', '/Users/me/.local/bin/claude', '/usr/bin/say'])
  const base = { home: HOME2, isExecutable: (p: string) => installed.has(p), loginPath: async () => undefined }

  test('a path is used as it is, found or not', async () => {
    expect(await resolveCommand('/opt/homebrew/bin/whisper-cli', { ...base, pathEnv: '/usr/bin' })).toBe('/opt/homebrew/bin/whisper-cli')
    expect(await resolveCommand('./tool', { ...base, pathEnv: '/usr/bin' })).toBe('./tool')
  })

  // Regression: an app opened from the Dock has PATH=/usr/bin:/bin:/usr/sbin:/sbin, so
  // "whisper-cli" (Homebrew) was "not found" although it runs fine in a terminal.
  test('finds a Homebrew program although the app was started with the bare system PATH', async () => {
    expect(await resolveCommand('whisper-cli', { ...base, pathEnv: '/usr/bin:/bin:/usr/sbin:/sbin' })).toBe('/opt/homebrew/bin/whisper-cli')
  })

  test("also looks in the user's own bin directories", async () => {
    expect(await resolveCommand('claude', { ...base, pathEnv: '/usr/bin' })).toBe('/Users/me/.local/bin/claude')
  })

  test('the process PATH comes first', async () => {
    const both = new Set(['/first/tool', '/opt/homebrew/bin/tool'])
    expect(await resolveCommand('tool', { home: HOME2, pathEnv: '/first:/usr/bin', isExecutable: (p) => both.has(p), loginPath: async () => undefined })).toBe('/first/tool')
  })

  test("falls back to the login shell's PATH only when nothing else finds it", async () => {
    let asked = 0
    const deps = { home: HOME2, pathEnv: '/usr/bin', isExecutable: (p: string) => p === '/custom/bin/mytool', loginPath: async () => { asked++; return '/custom/bin:/usr/bin' } }
    expect(await resolveCommand('mytool', deps)).toBe('/custom/bin/mytool')
    expect(asked).toBe(1)
    expect(await resolveCommand('whisper-cli', { ...base, pathEnv: '/usr/bin' })).toBe('/opt/homebrew/bin/whisper-cli')
  })

  test('not installed anywhere: undefined, so the caller can say so', async () => {
    expect(await resolveCommand('nope', { ...base, pathEnv: '/usr/bin' })).toBeUndefined()
  })
})

describe('transcribe with a program outside the app PATH', () => {
  test('runs the resolved absolute path, not the bare name', async () => {
    const calls: string[] = []
    const d: VoiceDeps = {
      home: HOME,
      loadVoice: () => ({ transcribeCommand: 'whisper-cli -f {audio}' }),
      writeAudio: async () => ({ path: '/tmp/cw/x.wav', cleanup: async () => undefined }),
      resolveCommand: async (c) => (c === 'whisper-cli' ? '/opt/homebrew/bin/whisper-cli' : undefined),
      run: async (command) => { calls.push(command); return { code: 0, stdout: 'hi', stderr: '' } },
    }
    expect(await transcribe(d, new Uint8Array([1]))).toEqual({ ok: true, text: 'hi' })
    expect(calls).toEqual(['/opt/homebrew/bin/whisper-cli'])
  })

  test('a program that cannot be found is reported by name before anything runs', async () => {
    const calls: string[] = []
    const d: VoiceDeps = {
      home: HOME,
      loadVoice: () => ({ transcribeCommand: 'whisper-cli -f {audio}' }),
      writeAudio: async () => ({ path: '/tmp/cw/x.wav', cleanup: async () => undefined }),
      resolveCommand: async () => undefined,
      run: async (command) => { calls.push(command); return { code: 0, stdout: 'hi', stderr: '' } },
    }
    const r = await transcribe(d, new Uint8Array([1]))
    expect(r.ok === false && r.reason).toMatch(/not found: whisper-cli/i)
    expect(calls).toEqual([])
  })
})
