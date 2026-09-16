export type DecodedSessionData = {
  sessionId: string
  chunk: string | Uint8Array
}

/**
 * Inverse of main-process `encodeSessionData`.
 * Returns the chunk unchanged — never strip ANSI; full VT must reach xterm.
 */
export function decodeSessionData(payload: unknown): DecodedSessionData | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const record = payload as Record<string, unknown>
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
  if (sessionId.length === 0) return null

  const chunk = record.chunk
  if (record.encoding === 'base64' && typeof chunk === 'string') {
    return { sessionId, chunk: decodeBase64(chunk) }
  }
  if (typeof chunk === 'string') {
    return { sessionId, chunk }
  }
  if (chunk instanceof Uint8Array) {
    return { sessionId, chunk }
  }
  return { sessionId, chunk: '' }
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}
