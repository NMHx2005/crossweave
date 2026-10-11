import { describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { imageSize } from '../src/images'

const pub = (name: string): string => fileURLToPath(new URL(`../public/${name}`, import.meta.url))

describe('the demo clip and its pictures', () => {
  test('the clip is an H.264 file under 4 MB, and the poster is a JPEG under 400 KB', () => {
    expect(statSync(pub('media/demo.mp4')).size).toBeLessThan(4 * 1024 * 1024)
    const head = readFileSync(pub('media/demo.mp4')).subarray(4, 8).toString('latin1')
    expect(head).toBe('ftyp')
    expect(statSync(pub('media/poster.jpg')).size).toBeLessThan(400 * 1024)
    expect([...readFileSync(pub('media/poster.jpg')).subarray(0, 2)]).toEqual([0xff, 0xd8])
  })

  test('the three step pictures and the share card are small and have the sizes the markup says', () => {
    for (const n of ['step-1.png', 'step-2.png', 'step-3.png']) {
      expect(statSync(pub(`img/${n}`)).size).toBeLessThan(400 * 1024)
      expect(imageSize(pub(`img/${n}`))).toEqual({ width: 1280, height: 720 })
    }
    expect(imageSize(pub('img/og.png'))).toEqual({ width: 1200, height: 630 })
    expect(statSync(pub('img/og.png')).size).toBeLessThan(400 * 1024)
  })
})
