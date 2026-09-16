export {}

declare global {
  interface Window {
    cockpit: {
      invoke(channel: string, payload?: unknown): Promise<unknown>
      listen(event: string, cb: (...args: unknown[]) => void): () => void
    }
  }
}
