import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export type Resolved = { file: string } | { status: 400 | 404 }

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${'/'}`) && !isAbsolute(rel)
}

/**
 * Which file of the build directory a request path names. Containment is checked on real paths with `relative`, not on a string prefix
 * (a sibling called `dist-backup` shares one), and a symlink that leaves the directory is refused.
 */
export function resolveRequest(dist: string, base: string, rawPath: string): Resolved {
  let path: string
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return { status: 400 }
  }
  if (path.includes('\0')) return { status: 400 }
  if (base !== '') {
    if (path !== base && !path.startsWith(`${base}/`)) return { status: 404 }
    path = path.slice(base.length) || '/'
  }
  const real = realpathSync(dist)
  const target = resolve(real, `.${path}`)
  if (!inside(real, target)) return { status: 404 }
  for (const candidate of [target, join(target, 'index.html')]) {
    if (!isFile(candidate)) continue
    const actual = realpathSync(candidate)
    return inside(real, actual) ? { file: candidate } : { status: 404 }
  }
  return { status: 404 }
}
