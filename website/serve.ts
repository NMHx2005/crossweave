/** A local preview of website/dist for the visual check: `bun website/build.ts && bun website/serve.ts`. Not used by the build or the deploy. */
import { statSync } from 'node:fs'
import { join, normalize } from 'node:path'

const dist = new URL('./dist', import.meta.url).pathname
const base = process.env['SITE_BASE'] ?? '/crossweave'
const port = Number(process.env['PORT'] ?? 4173)

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(request) {
    let path = decodeURIComponent(new URL(request.url).pathname)
    if (base !== '' && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length) || '/'
    const target = normalize(join(dist, path))
    if (!target.startsWith(dist)) return new Response('bad path', { status: 400 })
    const found = [target, join(target, 'index.html')].find(isFile)
    return found === undefined ? new Response(Bun.file(join(dist, '404.html')), { status: 404 }) : new Response(Bun.file(found))
  },
})
console.log(`http://127.0.0.1:${port}${base}/`)
