import { describe, expect, test } from 'bun:test'
import { audioStats, isPhantomTranscript, isSilent, SILENCE_PEAK } from '../src/lib/voice-audio'

describe('audioStats', () => {
  test('peak is the loudest sample, rms the average power', () => {
    const s = audioStats(new Float32Array([0, 0.5, -0.25, 0]))
    expect(s.peak).toBeCloseTo(0.5)
    expect(s.rms).toBeCloseTo(Math.sqrt((0.25 + 0.0625) / 4))
  })

  test('no samples is silence, not a division by zero', () => {
    expect(audioStats(new Float32Array([]))).toEqual({ peak: 0, rms: 0 })
  })
})

describe('isSilent', () => {
  test('room noise is silent, ordinary speech is not', () => {
    expect(isSilent({ peak: 0.003, rms: 0.0008 })).toBe(true)
    expect(isSilent({ peak: SILENCE_PEAK - 0.001, rms: 0.001 })).toBe(true)
    expect(isSilent({ peak: 0.2, rms: 0.03 })).toBe(false)
  })
})

// Regression: a silent recording made whisper print "Cảm ơn các bạn đã theo dõi và ủng hộ cho
// kênh …", the outro of a video it was trained on, which was then offered as the transcript.
describe('isPhantomTranscript', () => {
  test('a known outro from a quiet recording is not what was said', () => {
    expect(isPhantomTranscript('Cảm ơn các bạn đã theo dõi và ủng hộ cho kênh lalas.', 0.04)).toBe(true)
    expect(isPhantomTranscript('Hãy subscribe cho kênh Ghiền Mì Gõ để không bỏ lỡ những video hấp dẫn', 0.03)).toBe(true)
    expect(isPhantomTranscript('Thanks for watching!', 0.03)).toBe(true)
    expect(isPhantomTranscript('Subtitles by the Amara.org community', 0.02)).toBe(true)
  })

  test('the same words from a loud recording are respected: someone may really say them', () => {
    expect(isPhantomTranscript('Cảm ơn các bạn đã theo dõi', 0.4)).toBe(false)
  })

  test('ordinary speech, quiet or loud, is never treated as a phantom', () => {
    expect(isPhantomTranscript('Kiểm tra giúp tôi trang transaction load chậm', 0.03)).toBe(false)
    expect(isPhantomTranscript('Cảm ơn, chạy test giúp tôi', 0.03)).toBe(false)
  })
})
