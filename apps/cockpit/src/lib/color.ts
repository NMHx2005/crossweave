/**
 * The color arithmetic the theme layer and its tests share: WCAG relative luminance
 * and contrast, and `color-mix(in srgb, a w, b)` as CSS computes it.
 */

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6)
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}

const hex2 = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** `color-mix(in srgb, a weightA, b)`, as #rrggbb. */
export function mix(a: string, b: string, weightA: number): string {
  const ca = channels(a)
  const cb = channels(b)
  return `#${ca.map((v, i) => hex2(v * weightA + (cb[i] as number) * (1 - weightA))).join('')}`
}

export function isDark(hex: string): boolean {
  return luminance(hex) < 0.18
}

/**
 * `color`, moved toward white or black (away from `against`) in small steps until the
 * pair reaches `min` — so a derived palette keeps its hues where it can and gives up
 * only as much as legibility needs. Gives the extreme if nothing short of it passes.
 */
export function ensureContrast(color: string, against: string, min: number): string {
  if (contrast(color, against) >= min) return color
  const target = isDark(against) ? '#ffffff' : '#000000'
  for (let step = 1; step <= 20; step++) {
    const next = mix(target, color, step / 20)
    if (contrast(next, against) >= min) return next
  }
  return target
}
