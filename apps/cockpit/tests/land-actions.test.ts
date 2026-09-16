import { describe, expect, test } from 'bun:test'
import {
  landAllReady,
  landSelected,
  parseConvergeStatus,
  type ConvergeStatus,
  type LandResult,
} from '../src/lib/land-actions'

const landed: LandResult = {
  status: 'landed',
  tested: 'clean',
  baseBranch: 'main',
  warnings: [],
}

function status(partial: Partial<ConvergeStatus> = {}): ConvergeStatus {
  return {
    ready: [],
    unknown: [],
    blocked: [],
    ...partial,
  }
}

describe('landSelected', () => {
  test('lands a ready session without force and returns landed', async () => {
    const calls: Array<{ name: string; force?: boolean }> = []
    const result = await landSelected({
      getStatus: async () => status({ ready: ['alpha'] }),
      land: async (name, force) => {
        calls.push({ name, force })
        return landed
      },
      name: 'alpha',
    })
    expect(result).toBe('landed')
    expect(calls).toEqual([{ name: 'alpha', force: false }])
  })

  test('does not land a blocked session', async () => {
    let landedName: string | undefined
    const result = await landSelected({
      getStatus: async () =>
        status({ blocked: [{ name: 'alpha', reason: 'latest trial with peer is conflict' }] }),
      land: async (name) => {
        landedName = name
        return landed
      },
      name: 'alpha',
    })
    expect(result).toBe('blocked')
    expect(landedName).toBeUndefined()
  })

  test('asks for confirm on unknown evidence and does not land', async () => {
    let landedName: string | undefined
    const result = await landSelected({
      getStatus: async () =>
        status({ unknown: [{ name: 'alpha', reason: 'no pairwise trial with peer' }] }),
      land: async (name) => {
        landedName = name
        return landed
      },
      name: 'alpha',
    })
    expect(result).toBe('needs_confirm_unknown')
    expect(landedName).toBeUndefined()
  })

  test('lands unknown evidence with force only when forceUnknown is set', async () => {
    const calls: Array<{ name: string; force?: boolean }> = []
    const result = await landSelected({
      getStatus: async () =>
        status({ unknown: [{ name: 'alpha', reason: 'no pairwise trial with peer' }] }),
      land: async (name, force) => {
        calls.push({ name, force })
        return landed
      },
      name: 'alpha',
      forceUnknown: true,
    })
    expect(result).toBe('landed')
    expect(calls).toEqual([{ name: 'alpha', force: true }])
  })

  test('never lands blocked even when forceUnknown is set', async () => {
    let landedName: string | undefined
    const result = await landSelected({
      getStatus: async () => status({ blocked: [{ name: 'alpha', reason: 'conflict' }] }),
      land: async (name) => {
        landedName = name
        return landed
      },
      name: 'alpha',
      forceUnknown: true,
    })
    expect(result).toBe('blocked')
    expect(landedName).toBeUndefined()
  })

  test('returns failed when land throws', async () => {
    const result = await landSelected({
      getStatus: async () => status({ ready: ['alpha'] }),
      land: async () => {
        throw new Error('merge failed')
      },
      name: 'alpha',
    })
    expect(result).toBe('failed')
  })

  test('returns failed when the session is not in converge status', async () => {
    let landedName: string | undefined
    const result = await landSelected({
      getStatus: async () => status({ ready: ['other'] }),
      land: async (name) => {
        landedName = name
        return landed
      },
      name: 'alpha',
    })
    expect(result).toBe('failed')
    expect(landedName).toBeUndefined()
  })
})

describe('landAllReady', () => {
  test('lands ready sessions in chooseNextLand order, re-fetching after each', async () => {
    const snapshots: ConvergeStatus[] = [
      status({ ready: ['alice', 'bob'], unknown: [{ name: 'carol', reason: 'unverified' }] }),
      status({ ready: ['bob'], unknown: [{ name: 'carol', reason: 'unverified' }] }),
      status({ ready: [], unknown: [{ name: 'carol', reason: 'unverified' }] }),
    ]
    const attempted: string[] = []
    const progress: string[] = []
    const result = await landAllReady({
      getStatus: async () => snapshots.shift() ?? status(),
      land: async (name) => {
        attempted.push(name)
        return landed
      },
      onProgress: (name) => {
        progress.push(name)
      },
    })
    expect(attempted).toEqual(['alice', 'bob'])
    expect(progress).toEqual(['alice', 'bob'])
    expect(result.landed).toEqual(['alice', 'bob'])
    expect(result.failedAt).toBeUndefined()
    expect(snapshots).toHaveLength(0)
  })

  test('never lands unknown or blocked sessions', async () => {
    const attempted: string[] = []
    const result = await landAllReady({
      getStatus: async () =>
        status({
          unknown: [{ name: 'maybe', reason: 'no pairwise trial with peer' }],
          blocked: [{ name: 'nope', reason: 'conflict' }],
        }),
      land: async (name) => {
        attempted.push(name)
        return landed
      },
      onProgress: () => {},
    })
    expect(attempted).toEqual([])
    expect(result.landed).toEqual([])
    expect(result.failedAt).toBeUndefined()
  })

  test('stops at the first land failure with failedAt and error', async () => {
    const snapshots: ConvergeStatus[] = [
      status({ ready: ['alice', 'bob'] }),
      status({ ready: ['bob'] }),
    ]
    const attempted: string[] = []
    const progress: string[] = []
    const result = await landAllReady({
      getStatus: async () => snapshots.shift() ?? status(),
      land: async (name) => {
        attempted.push(name)
        if (name === 'bob') throw new Error('conflict')
        return landed
      },
      onProgress: (name) => {
        progress.push(name)
      },
    })
    expect(attempted).toEqual(['alice', 'bob'])
    expect(progress).toEqual(['alice'])
    expect(result.landed).toEqual(['alice'])
    expect(result.failedAt).toBe('bob')
    expect(result.error).toBe('conflict')
  })
})

describe('parseConvergeStatus', () => {
  test('keeps ready names and unknown/blocked reasons', () => {
    const parsed = parseConvergeStatus({
      ready: ['alpha'],
      unknown: [{ name: 'beta', reason: 'unverified' }],
      blocked: [{ name: 'gamma', reason: 'conflict' }],
    })
    expect(parsed).toEqual({
      ready: ['alpha'],
      unknown: [{ name: 'beta', reason: 'unverified' }],
      blocked: [{ name: 'gamma', reason: 'conflict' }],
    })
  })

  test('empty or non-object is empty buckets', () => {
    expect(parseConvergeStatus(undefined)).toEqual({ ready: [], unknown: [], blocked: [] })
    expect(parseConvergeStatus([])).toEqual({ ready: [], unknown: [], blocked: [] })
  })
})
