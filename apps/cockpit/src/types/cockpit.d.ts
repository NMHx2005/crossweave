export {}

declare global {
  interface Window {
    cockpit: {
      invoke(channel: string, payload?: unknown): Promise<unknown>
      listen(event: string, cb: (payload: unknown) => void): () => void
    }
  }
}
