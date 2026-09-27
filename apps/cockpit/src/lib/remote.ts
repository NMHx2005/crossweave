/**
 * Pure helpers for Settings → Remote and the pairing dialog.
 */

/** One SVG path for the dark modules of a QR matrix (offset by a quiet zone): one node, not hundreds. */
export function qrPath(matrix: boolean[][], quiet = 4): string {
  let d = ''
  matrix.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (dark) d += `M${c + quiet} ${r + quiet}h1v1h-1z`
    })
  })
  return d
}

/** Seconds left on a pairing code, never negative. */
export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

export function reachLabel(reach: 'tailscale' | 'wifi'): string {
  return reach === 'tailscale' ? 'Tailscale' : 'Same Wi-Fi'
}

/** "just now", "5 min ago", "3 h ago", or the date — for a device's last-seen time. */
export function lastSeen(iso: string | null, now: number): string {
  if (iso === null) return 'never'
  const ms = now - Date.parse(iso)
  if (!(ms >= 0)) return iso.slice(0, 10)
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return iso.slice(0, 10)
}
