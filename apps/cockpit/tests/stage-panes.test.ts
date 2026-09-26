import { describe, expect, test } from 'bun:test'
import { pickPanes } from '../src/lib/panes'

const s = (id: string) => ({ id, name: id, status: 'running' })
const t = (terminalId: string, sessionId: string) => ({ terminalId, sessionId, sessionName: sessionId })
const keys = (panes: ReturnType<typeof pickPanes>) =>
  panes.map((p) => (p.kind === 'session' ? `s:${p.session.id}` : `t:${p.terminal.terminalId}`))

describe('pickPanes', () => {
  test('shows sessions, then terminals, within the four-pane grid', () => {
    expect(keys(pickPanes([s('a'), s('b')], [t('t1', 'a')], 'a'))).toEqual(['s:a', 's:b', 't:t1'])
  })

  // Terminals take slots from sessions, but never the focused one's.
  test('with a full grid, terminals displace the unfocused sessions', () => {
    const sessions = [s('a'), s('b'), s('c'), s('d')]
    expect(keys(pickPanes(sessions, [t('t1', 'c')], 'c'))).toEqual(['s:c', 's:a', 's:b', 't:t1'])
  })

  test('shows at most two terminals, the newest ones', () => {
    const panes = pickPanes([s('a')], [t('t1', 'a'), t('t2', 'a'), t('t3', 'a')], 'a')
    expect(keys(panes)).toEqual(['s:a', 't:t2', 't:t3'])
  })

  test('a terminal can show with no session panes at all', () => {
    expect(keys(pickPanes([], [t('t1', 'gone')], null))).toEqual(['t:t1'])
  })
})
