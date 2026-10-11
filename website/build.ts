import type { BuildOptions } from './src/types'

export async function build(_options: BuildOptions): Promise<void> {
  throw new Error('the build is written in Task 7')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined
  await build({
    out: out ?? new URL('./dist', import.meta.url).pathname,
    env: process.env,
    repoRoot: new URL('..', import.meta.url).pathname.replace(/\/$/, ''),
    refreshRelease: args.includes('--refresh-release'),
  })
}
