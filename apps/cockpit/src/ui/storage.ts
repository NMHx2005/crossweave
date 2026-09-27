/** Per-viewer conveniences only; every read and write survives unavailable storage. */

export function readString(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // a convenience: the next window starts from its default
  }
}

export function readStringList(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : []
  } catch {
    return []
  }
}

export function writeStringList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // storage unavailable
  }
}

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // storage unavailable
  }
}

export function baseName(root: string): string {
  return root.split('/').filter((p) => p !== '').pop() ?? root
}

/** The launcher the last new session started with, preselected next time. */
export const LAST_LAUNCHER_KEY = 'cw.last-launcher.v1'
