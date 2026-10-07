import { isNewerVersion, parseSemver } from '../../../src/update/semver.js'
import type { GlobalConfig } from '../../../src/update/global-config.js'

export const RELEASES_URL = 'https://github.com/NMHx2005/crossweave/releases'

/** The part of ~/.crossweave/config.json the notice reads and writes; the CLI's `updateCheck` switch is the same one. */
export type NoticeConfig = Pick<GlobalConfig, 'updateCheck' | 'cockpitDismissedVersion'>

export type UpdateStatus = { enabled: boolean; available?: { version: string } }

/** Everything that touches the machine, passed in so the logic is testable. */
export type UpdateNoticeDeps = {
  currentVersion: string
  load: () => NoticeConfig
  save: (config: NoticeConfig) => void
  /** The latest release tag, or undefined on any failure (offline, 403, garbage): a notice is never worth an error. */
  fetchTag: () => Promise<string | undefined>
  now: () => number
  openExternal: (url: string) => Promise<void>
}

/** An answer is good for hours: a release is not news by the minute, and the API allows few anonymous calls. */
const FRESH_MS = 6 * 60 * 60_000
/** After a failure, the next try waits, so a machine that is offline does not retry on every poll. */
const RETRY_MS = 30 * 60_000

/**
 * "A newer version exists" for the window. The renderer only ever hears a version number; what is opened on
 * Download is built here from the tag the lookup returned (checked to be a version), not from anything the caller
 * passes. Off, nothing leaves the machine.
 */
export function createUpdateNotice(deps: UpdateNoticeDeps) {
  let latest: string | undefined
  let checkedAt: number | undefined
  let failedAt: number | undefined

  async function refresh(): Promise<void> {
    const now = deps.now()
    if (checkedAt !== undefined && now - checkedAt < FRESH_MS) return
    if (failedAt !== undefined && now - failedAt < RETRY_MS) return
    let tag: string | undefined
    try {
      tag = await deps.fetchTag()
    } catch {
      tag = undefined
    }
    if (tag === undefined || parseSemver(tag) === undefined) {
      failedAt = now
      return
    }
    latest = tag
    checkedAt = now
    failedAt = undefined
  }

  return {
    async status(): Promise<UpdateStatus> {
      const config = deps.load()
      if (!config.updateCheck) return { enabled: false }
      await refresh()
      if (latest === undefined || !isNewerVersion(latest, deps.currentVersion)) return { enabled: true }
      const version = latest.replace(/^v/, '')
      return config.cockpitDismissedVersion === version ? { enabled: true } : { enabled: true, available: { version } }
    },

    /** "Later": hides this version only, so the next release is announced again. */
    async dismiss(version: string): Promise<void> {
      if (parseSemver(version) === undefined) return
      deps.save({ ...deps.load(), cockpitDismissedVersion: version.replace(/^v/, '') })
    },

    async setEnabled(enabled: boolean): Promise<void> {
      deps.save({ ...deps.load(), updateCheck: enabled })
      // Switching it on is a request to know now, not at the next window of the cache.
      if (enabled) { checkedAt = undefined; failedAt = undefined }
    },

    async open(): Promise<void> {
      if (latest === undefined || parseSemver(latest) === undefined) return
      await deps.openExternal(`${RELEASES_URL}/tag/${latest}`)
    },
  }
}
