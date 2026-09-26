import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argvAdapter } from '../../../tests/helpers/argv-adapter.ts'
import type { SessionRow } from '../../../src/db/repositories/session.ts'
import { SessionRuntime } from '../../../src/daemon/runtime.ts'
import { encodeSessionData } from '../electron/daemon-bridge'
import { decodeSessionData } from '../src/lib/session-data'
import { formatRailMeta, isSessionRunning, parseSessionList, workspaceSummary } from '../src/lib/sessions'

/** Contrast helper only — XtermPane must never do this. */
function stripCsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

const SPINNER_FRAME = '\x1b[2K\x1b[1G\x1b[?25l⠋ Thinking…'

describe('decodeSessionData', () => {
  test('keeps string chunks including CSI (no strip-ANSI)', () => {
    const decoded = decodeSessionData({ sessionId: 's1', chunk: SPINNER_FRAME })
    expect(decoded).toEqual({ sessionId: 's1', chunk: SPINNER_FRAME })
    expect(typeof decoded?.chunk === 'string' && decoded.chunk.includes('\x1b[')).toBe(true)
    expect(stripCsi(SPINNER_FRAME)).toBe('⠋ Thinking…')
  })

  test('decodes base64 bytes back to the original VT', () => {
    const bytes = new Uint8Array([0x1b, 0x5b, 0x32, 0x4b, 0x68, 0x69]) // ESC [ 2 K h i
    const encoded = encodeSessionData({ sessionId: 's1', chunk: bytes })
    expect(encoded.encoding).toBe('base64')
    const decoded = decodeSessionData(encoded)
    expect(decoded?.sessionId).toBe('s1')
    expect(decoded?.chunk).toBeInstanceOf(Uint8Array)
    expect(Array.from(decoded?.chunk as Uint8Array)).toEqual(Array.from(bytes))
  })

  test('string encode/decode is a no-op', () => {
    const encoded = encodeSessionData({ sessionId: 's1', chunk: SPINNER_FRAME })
    expect(encoded).toEqual({ sessionId: 's1', chunk: SPINNER_FRAME })
    expect(decodeSessionData(encoded)).toEqual({ sessionId: 's1', chunk: SPINNER_FRAME })
  })

  test('rejects payloads without a session id', () => {
    expect(decodeSessionData({ chunk: 'hi' })).toBeNull()
    expect(decodeSessionData(null)).toBeNull()
    expect(decodeSessionData('s1')).toBeNull()
  })

  test('bad base64 yields empty bytes instead of throwing', () => {
    const decoded = decodeSessionData({ sessionId: 's1', chunk: '!!!not-base64!!!', encoding: 'base64' })
    expect(decoded).toEqual({ sessionId: 's1', chunk: new Uint8Array(0) })
  })
})

describe('parseSessionList', () => {
  test('keeps id/name/status and drops junk', () => {
    expect(
      parseSessionList([
        { id: 's1', name: 'alpha', status: 'running' },
        { name: 'orphan' },
        null,
        { id: 's2' },
      ]),
    ).toEqual([
      { id: 's1', name: 'alpha', status: 'running' },
      { id: 's2', name: 's2' },
    ])
  })

  test('keeps the branch and the dev port; ignores fields the rail no longer shows', () => {
    expect(
      parseSessionList([
        { id: 's1', name: 'alpha', status: 'running', branch: 'cw/alpha', leases: { portBase: 43010 }, enforcementTier: 'T2' },
        { id: 's2', name: 'shared', status: 'idle', branch: null, worktreePath: null },
      ]),
    ).toEqual([
      { id: 's1', name: 'alpha', status: 'running', branch: 'cw/alpha', portBase: 43010 },
      { id: 's2', name: 'shared', status: 'idle', branch: null, worktreePath: null },
    ])
  })

  test('formatRailMeta says where the session works and its port while running', () => {
    expect(formatRailMeta({ id: 's1', name: 'alpha' })).toBeUndefined()
    expect(formatRailMeta({ id: 's1', name: 'alpha', branch: 'cw/alpha', portBase: 43010 })).toBe('cw/alpha · port 43010')
    expect(formatRailMeta({ id: 's2', name: 'b', branch: null })).toBe('shared checkout')
  })

  test('empty or non-array is empty', () => {
    expect(parseSessionList(undefined)).toEqual([])
    expect(parseSessionList({ sessions: [] })).toEqual([])
  })
})

function collectDecoded(seen: string[]) {
  return {
    notify(method: string, params: unknown) {
      if (method !== 'session.data') return
      const decoded = decodeSessionData(encodeSessionData(params))
      if (!decoded) return
      const text =
        typeof decoded.chunk === 'string' ? decoded.chunk : new TextDecoder().decode(decoded.chunk)
      seen.push(text)
    },
    onClose() {
      return undefined
    },
  }
}

describe('fidelity attach path', () => {
  test('PTY CSI spinner frames survive encode/decode (M9 contrast)', async () => {
    const runtime = new SessionRuntime(() => undefined)
    const row: SessionRow = {
      id: 's_fid',
      workspaceId: 'ws',
      name: 'fid',
      agentKind: 'claude',
      adapter: 'claude',
      status: 'running',
      worktreePath: mkdtempSync(join(tmpdir(), 'cw-fid-')),
      branch: null,
      createdAt: '',
      lastActiveAt: '',
      tokenBudget: null,
      tokenSpent: 0,
      costBudgetUsd: null,
      costSpentUsd: 0,
      enforcementTier: 'T2',
      pid: null,
    }
    const seen: string[] = []
    runtime.start(
      row,
      argvAdapter(['sh', '-c', 'printf "\\033[2K\\033[1G⠋ Thinking…"; sleep 2']),
    )
    runtime.subscribe(row.id, row.name, collectDecoded(seen))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !seen.join('').includes('\x1b[')) {
      await new Promise((r) => setTimeout(r, 25))
    }
    const joined = seen.join('')
    expect(joined.includes('\x1b[')).toBe(true)
    expect(joined.includes('Thinking')).toBe(true)
    expect(stripCsi(joined).includes('\x1b[')).toBe(false)
    await runtime.stop(row.id, 200)
  }, 15_000)

  test('isSessionRunning counts only a real agent process', () => {
    // Drives the rail's Start/Stop buttons, which is how a stopped session gets going
    // again without the pane having to say "not running" first.
    expect(isSessionRunning({ status: 'running' })).toBe(true)
    expect(isSessionRunning({ status: 'waiting' })).toBe(false)
    for (const status of ['idle', 'stopped', 'killed', '', undefined]) {
      expect(isSessionRunning({ status })).toBe(false)
    }
  })
})

describe('workspaceSummary', () => {
  test('names the workspace, its base branch, and how many shells are open', () => {
    const sessions = [
      { id: 'a', name: 'a', status: 'running' },
      { id: 'b', name: 'b', status: 'idle' },
      { id: 'c', name: 'c', status: 'waiting' },
      { id: 'd', name: 'd', status: 'dead' },
    ]
    expect(workspaceSummary('/Users/me/work/shop/', 'main', sessions))
      .toEqual({ title: 'shop', meta: 'main · 2 of 3 running' })
    expect(workspaceSummary('/r', null, []).meta).toBe('detached HEAD · 0 of 0 running')
  })
})
