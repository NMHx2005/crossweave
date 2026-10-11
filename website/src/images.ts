import { readFileSync } from 'node:fs'

/** Width and height from a PNG's IHDR chunk, so every `<img>` states its real size without an image library. */
export function imageSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || !signature.every((b, i) => bytes[i] === b)) throw new Error(`${path} is not a PNG`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
