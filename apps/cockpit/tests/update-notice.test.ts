import { describe, expect, test } from 'bun:test'
import { createUpdateNotice, RELEASES_URL, type UpdateNoticeDeps } from '../electron/update-notice'

type Config = { updateCheck: boolean; cockpitDismissedVersion: string | null }

function setup(over: Partial<UpdateNoticeDeps> & { config?: Partial<Config>; tag?: string | undefined | (() => Promise<string | undefined>) } = {}) {
  let config: Config = { updateCheck: true, cockpitDismissedVersion: null, ...over.config }
  let clock = 1_000_000
  const log = { fetches: 0, opened: [] as string[], saves: 0 }
  const tag = over.tag
  const deps: UpdateNoticeDeps = {
    currentVersion: '0.5.0',
    load: () => config,
    save: (next) => { config = next; log.saves += 1 },
    fetchTag: async () => {
      log.fetches += 1
      if (typeof tag === 'function') return tag()
      return 'tag' in over ? tag : 'v0.6.0'
    },
    now: () => clock,
    openExternal: async (url) => { log.opened.push(url) },
  }
  return { notice: createUpdateNotice(deps), log, config: () => config, tick: (ms: number) => { clock += ms } }
}

describe('update notice', () => {
  test('a newer release is offered, with its version', async () => {
    const { notice } = setup()
    expect(await notice.status()).toEqual({ enabled: true, available: { version: '0.6.0' } })
  })

  test('the same or an older release, or one that is not a version at all, offers nothing', async () => {
    for (const tag of ['v0.5.0', 'v0.4.9', 'nightly', '', undefined]) {
      expect(await setup({ tag }).notice.status()).toEqual({ enabled: true })
    }
  })

  test('switched off, it says so and never touches the network', async () => {
    const { notice, log } = setup({ config: { updateCheck: false } })
    expect(await notice.status()).toEqual({ enabled: false })
    expect(log.fetches).toBe(0)
  })

  test('a failed lookup is silent, and is not retried on every call', async () => {
    const { notice, log, tick } = setup({ tag: async () => { throw new Error('offline') } })
    expect(await notice.status()).toEqual({ enabled: true })
    await notice.status()
    expect(log.fetches).toBe(1)
    tick(31 * 60_000)
    await notice.status()
    expect(log.fetches).toBe(2)
  })

  test('an answer is reused for hours, then asked again', async () => {
    const { notice, log, tick } = setup()
    await notice.status()
    tick(60 * 60_000)
    await notice.status()
    expect(log.fetches).toBe(1)
    tick(6 * 60 * 60_000)
    await notice.status()
    expect(log.fetches).toBe(2)
  })

  test('Later hides that version for good, but not a newer one', async () => {
    const { notice, config } = setup()
    await notice.dismiss('0.6.0')
    expect(config().cockpitDismissedVersion).toBe('0.6.0')
    expect(await notice.status()).toEqual({ enabled: true })

    const next = setup({ config: { cockpitDismissedVersion: '0.6.0' }, tag: 'v0.7.0' })
    expect(await next.notice.status()).toEqual({ enabled: true, available: { version: '0.7.0' } })
  })

  test('a dismissal that is not a version is refused and stores nothing', async () => {
    const { notice, log } = setup()
    await notice.dismiss('<script>')
    expect(log.saves).toBe(0)
  })

  test('the switch is stored, and switching it on checks again at once', async () => {
    const { notice, config, log } = setup({ config: { updateCheck: false } })
    await notice.setEnabled(true)
    expect(config().updateCheck).toBe(true)
    expect(await notice.status()).toEqual({ enabled: true, available: { version: '0.6.0' } })
    expect(log.fetches).toBe(1)
    await notice.setEnabled(false)
    expect(config().updateCheck).toBe(false)
  })

  test('Download opens the releases page of the release it announced — never an address from the caller', async () => {
    const { notice, log } = setup()
    await notice.open()
    expect(log.opened).toEqual([])
    await notice.status()
    await notice.open()
    expect(log.opened).toEqual([`${RELEASES_URL}/tag/v0.6.0`])
  })
})
