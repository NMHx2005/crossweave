import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRequest } from '../src/preview'

let root = ''
let dist = ''
// The temp directory itself may sit behind a symlink (/var is /private/var on macOS); the resolver answers with real paths.
let real = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cw-preview-'))
  dist = join(root, 'dist')
  mkdirSync(join(dist, 'docs'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), 'home')
  writeFileSync(join(dist, '404.html'), 'missing')
  writeFileSync(join(dist, 'docs', 'index.html'), 'docs')
  writeFileSync(join(dist, 'styles.css'), 'css')
  // A sibling that merely starts with the same name, and a file outside entirely: neither may ever be served.
  mkdirSync(join(root, 'dist-backup'))
  writeFileSync(join(root, 'dist-backup', 'secret.txt'), 'nope')
  writeFileSync(join(root, 'outside.txt'), 'nope')
  symlinkSync(join(root, 'outside.txt'), join(dist, 'leak.txt'))
  real = realpathSync(dist)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('resolveRequest', () => {
  test('serves a file, a directory index and the root, under the base', () => {
    expect(resolveRequest(dist, '/crossweave', '/crossweave/styles.css')).toEqual({ file: join(real, 'styles.css') })
    expect(resolveRequest(dist, '/crossweave', '/crossweave/docs/')).toEqual({ file: join(real, 'docs', 'index.html') })
    expect(resolveRequest(dist, '/crossweave', '/crossweave')).toEqual({ file: join(real, 'index.html') })
    expect(resolveRequest(dist, '', '/docs/')).toEqual({ file: join(real, 'docs', 'index.html') })
  })

  test('a path outside the base, or to nothing, is a 404', () => {
    expect(resolveRequest(dist, '/crossweave', '/other/styles.css')).toEqual({ status: 404 })
    expect(resolveRequest(dist, '/crossweave', '/crossweave/nope')).toEqual({ status: 404 })
  })

  test('a sibling directory with the same prefix is not reachable, however the dots are written', () => {
    for (const path of ['/crossweave/..%2Fdist-backup/secret.txt', '/crossweave/../dist-backup/secret.txt', '/crossweave/%2e%2e/dist-backup/secret.txt', '/crossweave/..%2f..%2foutside.txt']) {
      const result = resolveRequest(dist, '/crossweave', path)
      expect('file' in result, path).toBe(false)
    }
  })

  test('a symlink that leaves the build directory is not followed', () => {
    expect(resolveRequest(dist, '/crossweave', '/crossweave/leak.txt')).toEqual({ status: 404 })
  })

  test('a malformed or NUL-carrying path is a 400', () => {
    expect(resolveRequest(dist, '/crossweave', '/crossweave/%E0%A4%A')).toEqual({ status: 400 })
    expect(resolveRequest(dist, '/crossweave', '/crossweave/a%00b')).toEqual({ status: 400 })
  })
})
