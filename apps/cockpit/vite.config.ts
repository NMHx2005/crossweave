import path from 'node:path'
import { fileURLToPath } from 'node:url'
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron/simple'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    // The one chunk that stays above Vite's default 500 kB is the editor (CodeMirror and its languages), which is
    // loaded only when a file is opened from the app's own disk; splitting it further would trade nothing for noise.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('/node_modules/@xterm/') ? 'xterm' : undefined),
      },
    },
  },
  plugins: [
    preact(),
    electron({
      main: {
        entry: 'electron/main.ts',
      },
      preload: {
        input: path.join(rootDir, 'electron/preload.ts'),
      },
    }),
  ],
})
