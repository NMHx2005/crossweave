import { describe, expect, test } from 'bun:test'
import { describeAttachFailure } from '../src/lib/attach-message'

describe('describeAttachFailure', () => {
  // The bar under a stopped session's pane says its shell is closed and reopens it;
  // a notice in the terminal too only repeated that.
  test('a session that is not running adds nothing to the pane', () => {
    const raw = "Error invoking remote method 'session.attach': CrossweaveError: Session is not running: alice"
    expect(describeAttachFailure(raw)).toBe('')
  })

  test('anything else keeps its own message, with only the transport wrappers stripped', () => {
    const raw = "Error invoking remote method 'session.attach': CrossweaveError: DAEMON_GONE: daemon is not reachable"
    expect(describeAttachFailure(raw)).toBe('DAEMON_GONE: daemon is not reachable')
  })

  test('an already-clean message passes through untouched', () => {
    expect(describeAttachFailure('boom')).toBe('boom')
  })
})
