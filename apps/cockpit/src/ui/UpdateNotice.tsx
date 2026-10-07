import { useEffect, useState } from 'preact/hooks'
import { cockpitApi } from '../host/cockpit-api'

/** Looked at on opening and then now and then: the main process answers from its own cache, so this costs nothing. */
const POLL_MS = 60 * 60_000

/**
 * A small corner notice when a newer release exists. It only reads a version number; "Download" asks main to
 * open the release page, "Later" hides this version. Nothing here can fail loudly: no answer is no notice.
 */
export function UpdateNotice() {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const look = (): void => {
      cockpitApi.updateStatus().then(
        (s) => { if (live) setVersion(s.enabled && s.available !== undefined ? s.available.version : null) },
        () => undefined,
      )
    }
    look()
    const timer = window.setInterval(look, POLL_MS)
    return () => { live = false; window.clearInterval(timer) }
  }, [])

  if (version === null) return null
  return (
    <div class="cockpit-update" role="status" aria-label="Update available">
      <span>crossweave {version} is available</span>
      <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => { void cockpitApi.updateOpen() }}>Download</button>
      <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost"
        onClick={() => { void cockpitApi.updateDismiss(version); setVersion(null) }}>Later</button>
    </div>
  )
}
