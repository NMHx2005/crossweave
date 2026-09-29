import { describe, expect, test } from 'bun:test'
import { concatChunks, downsample, encodeWav16 } from '../src/lib/wav'

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.slice(from, to))
const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

describe('concatChunks', () => {
  test('joins the recorder\'s chunks in order', () => {
    expect([...concatChunks([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([])])]).toEqual([1, 2, 3])
    expect(concatChunks([]).length).toBe(0)
  })
})

describe('downsample', () => {
  test('to the same rate is the same samples', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect([...downsample(input, 16000, 16000)]).toEqual([...input])
  })

  test('48 kHz to 16 kHz keeps a third of the samples (averaged over each step)', () => {
    const input = new Float32Array(48).fill(0.5)
    const out = downsample(input, 48000, 16000)
    expect(out.length).toBe(16)
    expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true)
  })

  test('averaging a step smooths a fast alternation instead of aliasing it', () => {
    const input = Float32Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? 1 : -1))
    const out = downsample(input, 48000, 16000)
    expect(out.length).toBe(2)
    expect(Math.abs(out[0]!)).toBeLessThan(0.5)
  })

  test('a rate below the target is returned unchanged rather than invented', () => {
    const input = new Float32Array([0.1, 0.2])
    expect(downsample(input, 8000, 16000)).toBe(input)
  })
})

describe('encodeWav16', () => {
  test('writes a canonical mono 16-bit PCM header', () => {
    const wav = encodeWav16(new Float32Array([0, 0.5, -0.5, 1]), 16000)
    const v = view(wav)
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(ascii(wav, 8, 12)).toBe('WAVE')
    expect(ascii(wav, 12, 16)).toBe('fmt ')
    expect(v.getUint32(16, true)).toBe(16) // fmt chunk size
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000) // byte rate
    expect(v.getUint16(32, true)).toBe(2) // block align
    expect(v.getUint16(34, true)).toBe(16)
    expect(ascii(wav, 36, 40)).toBe('data')
    expect(v.getUint32(40, true)).toBe(8) // 4 samples x 2 bytes
    expect(v.getUint32(4, true)).toBe(wav.length - 8)
    expect(wav.length).toBe(44 + 8)
  })

  test('scales samples to signed 16-bit and clips anything outside -1..1', () => {
    const wav = encodeWav16(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000)
    const v = view(wav)
    const s = (i: number): number => v.getInt16(44 + i * 2, true)
    expect(s(0)).toBe(0)
    expect(s(1)).toBe(32767)
    expect(s(2)).toBe(-32768)
    expect(s(3)).toBe(32767)
    expect(s(4)).toBe(-32768)
    expect(s(5)).toBe(16384)
  })

  test('no samples still gives a valid empty file', () => {
    const wav = encodeWav16(new Float32Array([]), 16000)
    expect(wav.length).toBe(44)
    expect(view(wav).getUint32(40, true)).toBe(0)
  })
})
