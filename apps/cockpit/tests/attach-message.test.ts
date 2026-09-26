import { describe, expect, test } from 'bun:test'
import { describeAttachFailure } from '../src/lib/attach-message'

describe('describeAttachFailure', () => {
  test('a session that is not running says so, and how to fix it — without the IPC plumbing', () => {
    const raw = "Error invoking remote method 'session.attach': CrossweaveError: Session is not running: alice"
    const described = describeAttachFailure(raw)
    expect(described).toBe('alice is not running.')
    expect(described).not.toContain('invoking remote method')
    expect(described).not.toContain('CrossweaveError')
  })

  test('anything else keeps its own message, with only the transport wrappers stripped', () => {
    const raw = "Error invoking remote method 'session.attach': CrossweaveError: DAEMON_GONE: daemon is not reachable"
    expect(describeAttachFailure(raw)).toBe('DAEMON_GONE: daemon is not reachable')
  })

  test('an already-clean message passes through untouched', () => {
    expect(describeAttachFailure('boom')).toBe('boom')
  })
})
