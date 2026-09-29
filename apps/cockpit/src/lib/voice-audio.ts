export interface AudioStats {
  peak: number
  rms: number
}

/** Loudest sample and average power of a recording (samples in -1..1). */
export function audioStats(samples: Float32Array): AudioStats {
  if (samples.length === 0) return { peak: 0, rms: 0 }
  let peak = 0
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number
    const a = Math.abs(v)
    if (a > peak) peak = a
    sumSquares += v * v
  }
  return { peak, rms: Math.sqrt(sumSquares / samples.length) }
}

/**
 * Below this peak nothing was said: the microphone heard room noise (or nothing). With noise
 * suppression on, a room reads a few thousandths; speech at a normal distance is far above.
 */
export const SILENCE_PEAK = 0.015

export function isSilent(stats: AudioStats): boolean {
  return stats.peak < SILENCE_PEAK
}

/** Above this a recording holds real sound, so an outro-like transcript may be genuine. */
const QUIET_PEAK = 0.08

/**
 * Whisper-family models, given near-silence, do not stay quiet: they print the outro of the
 * videos they were trained on. These are the recurring ones; a transcript that is exactly
 * such a line from a quiet recording is a hallucination, not speech.
 */
const PHANTOMS: readonly RegExp[] = [
  /^c[aả]m [oơ]n c[aá]c b[aạ]n (?:[đd][aã] )?(?:theo d[oõ]i|xem)/i,
  /^h[aã]y (?:subscribe|[đd][aă]ng k[yý])/i,
  /^thanks? for watching/i,
  /^thank you for watching/i,
  /^subtitles? by/i,
  /^please subscribe/i,
  /^(?:vui l[oò]ng )?[đd][aă]ng k[yý] k[eê]nh/i,
]

export function isPhantomTranscript(text: string, peak: number): boolean {
  if (peak >= QUIET_PEAK) return false
  const t = text.trim().replace(/^["“”'\s]+/, '')
  return PHANTOMS.some((p) => p.test(t))
}

/** What to say when the take held no speech. */
export const SILENCE_MESSAGE = 'The microphone recorded silence. Check the input in System Settings → Sound → Input (and its level), then speak while the bar under the draft moves.'
