/** A local preview of website/dist for the visual check: `bun website/build.ts && PORT=4173 bun website/serve.ts`. Not used by the build or the deploy. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRequest } from './src/preview'

const dist = fileURLToPath(new URL('./dist', import.meta.url))
const base = process.env['SITE_BASE'] ?? '/crossweave'
const port = Number(process.env['PORT'] ?? 4173)

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(request) {
    const resolved = resolveRequest(dist, base, new URL(request.url).pathname)
    if ('file' in resolved) return new Response(Bun.file(resolved.file))
    return resolved.status === 400 ? new Response('bad path', { status: 400 }) : new Response(Bun.file(join(dist, '404.html')), { status: 404 })
  },
})
console.log(`http://127.0.0.1:${port}${base}/`)
