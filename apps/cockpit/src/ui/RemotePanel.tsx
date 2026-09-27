import { useEffect, useState } from 'preact/hooks'
import type { RemoteSettings } from '../../../../src/core/settings.js'
import type { RemoteState } from '../../electron/remote-host'
import { lastSeen, qrPath, reachLabel, secondsLeft } from '../lib/remote'

const DEFAULT_PORT = 7788

/**
 * Settings → Remote: whether a phone may reach this Mac's sessions, and how (Tailscale,
 * the same Wi-Fi, or both). The switches are part of the Settings draft and apply on
 * Save; pairing and removing a phone act at once, on what is running now.
 */
export function RemoteSection({ draft, onChange, state, onPair, onRevoke }: {
  draft: RemoteSettings | undefined
  onChange: (next: RemoteSettings | undefined) => void
  state: RemoteState | null
  onPair: () => void
  onRevoke: (id: string) => void
}) {
  const r = draft ?? {}
  const set = (patch: Partial<RemoteSettings>): void => onChange({ ...r, ...patch })
  const wifi = state?.addresses.wifi ?? []
  const tailscale = state?.addresses.tailscale
  const peers = new Set((state?.peers ?? []).map((p) => p.id))
  const now = Date.now()

  return (
    <>
      <h3 class="cockpit-settings__heading">Remote</h3>
      <p class="cockpit-muted">
        Watch and answer your sessions from your phone. Only phones you pair can connect, only over your
        Tailscale network or the same Wi-Fi, and they can never delete, land or kill anything.
      </p>
      <label class="cockpit-settings__toggle">
        <input type="checkbox" checked={r.enabled === true}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked
            // Turned on with nothing chosen: offer what this Mac has, Tailscale first.
            if (on && r.tailscale !== true && r.wifi !== true) {
              set({ enabled: true, ...(tailscale !== undefined ? { tailscale: true } : { wifi: true, ...(wifi[0] ? { wifiAddress: wifi[0].address } : {}) }) })
            } else set({ enabled: on })
          }} />
        <span>Let my phone reach this Mac's sessions</span>
      </label>
      {r.enabled === true ? (
        <div class="cockpit-remote__form">
          <label class="cockpit-settings__toggle">
            <input type="checkbox" checked={r.tailscale === true} onChange={(e) => set({ tailscale: (e.target as HTMLInputElement).checked })} />
            <span>Tailscale {tailscale !== undefined
              ? <span class="cockpit-muted">— this Mac is {tailscale}; works from anywhere</span>
              : <span class="cockpit-muted">— not running on this Mac; install it here and on the phone, signed in to the same account</span>}</span>
          </label>
          <label class="cockpit-settings__toggle">
            <input type="checkbox" checked={r.wifi === true}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked
                // Pinned to an address, so moving to another network never serves there unasked.
                set({ wifi: on, ...(on && r.wifiAddress === undefined && wifi[0] ? { wifiAddress: wifi[0].address } : {}) })
              }} />
            <span>Same Wi-Fi <span class="cockpit-muted">— HTTPS with a certificate made on this Mac; the phone warns once</span></span>
          </label>
          {r.wifi === true ? (
            <label class="cockpit-picker__field">
              <span class="cockpit-muted">Wi-Fi address</span>
              <select value={r.wifiAddress ?? ''} onChange={(e) => set({ wifiAddress: (e.target as HTMLSelectElement).value })}>
                {r.wifiAddress !== undefined && !wifi.some((w) => w.address === r.wifiAddress)
                  ? <option value={r.wifiAddress}>{r.wifiAddress} (not on this Mac now)</option> : null}
                {wifi.map((w) => <option key={w.address} value={w.address}>{w.address} ({w.interface})</option>)}
              </select>
            </label>
          ) : null}
          <label class="cockpit-picker__field cockpit-remote__port">
            <span class="cockpit-muted">Port</span>
            <input type="number" min={1024} max={65535} value={r.port ?? DEFAULT_PORT}
              onInput={(e) => {
                const n = Number((e.target as HTMLInputElement).value)
                set({ port: Number.isInteger(n) ? n : DEFAULT_PORT })
              }} />
          </label>
        </div>
      ) : null}

      {state?.enabled ? (
        <div class="cockpit-remote__status" role="status">
          {state.listening.map((l) => (
            <p key={l.url}><span class="cockpit-remote__dot" data-on="true" /> {reachLabel(l.reach)}: <code>{l.url}</code></p>
          ))}
          {state.problems.map((p) => <p key={p} class="cockpit-remote__problem">{p}</p>)}
          {state.caFingerprint !== undefined ? (
            <p class="cockpit-muted cockpit-remote__fingerprint">Wi-Fi certificate (SHA-256): <code>{state.caFingerprint}</code></p>
          ) : null}
          <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={state.listening.length === 0} onClick={onPair}>Pair a phone…</button>
        </div>
      ) : r.enabled === true ? <p class="cockpit-muted">Save to start remote access.</p> : null}

      {(state?.devices.length ?? 0) > 0 ? (
        <ul class="cockpit-remote__devices" aria-label="Paired phones">
          {state?.devices.map((d) => (
            <li key={d.id}>
              <span class="cockpit-remote__dot" data-on={peers.has(d.id) ? 'true' : 'false'} />
              <span class="cockpit-remote__name">{d.name}</span>
              <span class="cockpit-muted">{peers.has(d.id) ? 'connected' : `last seen ${lastSeen(d.lastSeenAt, now)}`}</span>
              <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => onRevoke(d.id)}>Remove</button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

/** The pairing code: a QR code per address, the code in words, and a countdown. */
export function PairDialog({ state, onRenew, onClose }: { state: RemoteState | null; onRenew: () => void; onClose: () => void }) {
  const [reach, setReach] = useState<'tailscale' | 'wifi' | null>(null)
  const [now, setNow] = useState(Date.now())
  const [openedAt] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const pair = state?.pair
  const paired = state?.paired !== undefined && state.paired.at >= openedAt ? state.paired : undefined
  const links = pair?.links ?? []
  const link = links.find((l) => l.reach === reach) ?? links[0]
  const left = pair ? secondsLeft(pair.expiresAt, now) : 0
  const size = link ? link.qr.length + 8 : 0

  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div class="cockpit-picker cockpit-pair" role="dialog" aria-label="Pair a phone"
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <h2 class="cockpit-picker__title">Pair a phone</h2>
        {paired !== undefined ? (
          <p class="cockpit-pair__done" role="status">✓ Paired {paired.name}. It can now reach your sessions.</p>
        ) : pair === undefined ? (
          <p class="cockpit-muted">Making a code…</p>
        ) : left === 0 ? (
          <p class="cockpit-muted">This code expired. <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={onRenew}>New code</button></p>
        ) : (
          <>
            {links.length > 1 ? (
              <div class="cockpit-settings__segmented" role="radiogroup" aria-label="Reach">
                {links.map((l) => (
                  <button key={l.reach} type="button" role="radio" aria-checked={l === link}
                    class={`cockpit-btn cockpit-btn--sm${l === link ? ' cockpit-btn--primary' : ''}`}
                    onClick={() => setReach(l.reach)}>{reachLabel(l.reach)}</button>
                ))}
              </div>
            ) : null}
            {link ? (
              <svg class="cockpit-pair__qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`QR code for ${link.url}`} shape-rendering="crispEdges">
                <rect class="cockpit-pair__qr-bg" width={size} height={size} />
                <path class="cockpit-pair__qr-fg" d={qrPath(link.qr)} />
              </svg>
            ) : null}
            <p class="cockpit-muted">Scan with the phone's camera{link?.reach === 'tailscale' ? ' (Tailscale must be on there too)' : ''}, or open <code>{link?.url.replace(/#.*$/, '')}</code> and type</p>
            <p class="cockpit-pair__code">{pair.display}</p>
            <p class="cockpit-muted">Valid for {left} s, once.</p>
          </>
        )}
        <div class="cockpit-picker__actions">
          <button type="button" class="cockpit-btn cockpit-btn--primary" onClick={onClose}>{paired ? 'Done' : 'Close'}</button>
        </div>
      </div>
    </div>
  )
}
