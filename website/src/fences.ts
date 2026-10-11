export interface FenceLine {
  line: string
  /** True for the lines of a fenced code block, the fence lines themselves included. */
  fenced: boolean
}

/**
 * Marks which lines of a markdown text are inside a fenced code block. A fence is closed only by a fence of the same character, at
 * least as long as the one that opened it and with nothing after it: a block opened with four backticks can show three backticks, or a
 * `~~~` line, as its content.
 */
export function scanFences(text: string): FenceLine[] {
  let open: { char: string; length: number } | null = null
  return text.split('\n').map((line) => {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    const marker = fence?.[1] ?? ''
    if (open === null) {
      if (fence === null) return { line, fenced: false }
      open = { char: marker.charAt(0), length: marker.length }
      return { line, fenced: true }
    }
    if (fence !== null && marker.charAt(0) === open.char && marker.length >= open.length && (fence[2] ?? '').trim() === '') open = null
    return { line, fenced: true }
  })
}
