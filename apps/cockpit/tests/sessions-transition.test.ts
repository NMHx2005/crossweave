import { describe, expect, test } from 'bun:test'
import { sessionsThatStartedRunning } from '../src/lib/sessions'

const s = (id: string, status: string) => ({ id, name: id, status })

describe('sessionsThatStartedRunning', () => {
  // A pane attached to a stopped session shows "not running — start it"; when the
  // session starts from ANYWHERE (the CLI, another window), that pane must re-attach.
  test('names sessions that went from not running to running or waiting', () => {
    const prev = [s('a', 'idle'), s('b', 'stopped'), s('c', 'running'), s('d', 'dead')]
    const next = [s('a', 'running'), s('b', 'waiting'), s('c', 'running'), s('d', 'dead')]
    expect(sessionsThatStartedRunning(prev, next)).toEqual(['a', 'b'])
  })

  test('ignores sessions that were already live, stopped, or are new to the list', () => {
    expect(sessionsThatStartedRunning([s('a', 'running')], [s('a', 'waiting')])).toEqual([])
    expect(sessionsThatStartedRunning([s('a', 'running')], [s('a', 'stopped')])).toEqual([])
    // A session first seen already running gets a fresh pane anyway; no bump needed.
    expect(sessionsThatStartedRunning([], [s('new', 'running')])).toEqual([])
  })
})
