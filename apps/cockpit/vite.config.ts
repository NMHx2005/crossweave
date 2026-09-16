import path from 'node:path'
import { fileURLToPath } from 'node:url'
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron/simple'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
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
