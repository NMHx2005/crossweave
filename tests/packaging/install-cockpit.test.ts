import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const INSTALLER = fileURLToPath(new URL('../../install.sh', import.meta.url))
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cw-install-cockpit-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function writeExecutable(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function fakeUname(system: 'Darwin' | 'Linux', machine: 'arm64' | 'x86_64'): string {
  const bin = join(root, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  const path = join(bin, 'uname')
  writeExecutable(path, `#!/bin/sh\ncase "$1" in\n  -s) echo ${system} ;;\n  -m) echo ${machine} ;;\n  *) exit 2 ;;\nesac\n`)
  return bin
}

function makeRelease(
  target: 'darwin-arm64' | 'linux-x64',
  options: { corruptCockpit?: boolean; includeCockpit?: boolean } = {},
): string {
  const { corruptCockpit = false, includeCockpit = target === 'darwin-arm64' } = options
  const release = join(root, 'release')
  mkdirSync(release, { recursive: true })
  writeExecutable(join(release, `cw-${target}`), '#!/bin/sh\necho v0.0.0-test\n')
  writeExecutable(join(release, `cwd-${target}`), '#!/bin/sh\necho daemon\n')

  const names = [`cw-${target}`, `cwd-${target}`]
  if (includeCockpit) {
    const staged = join(root, 'staged-app')
    const executable = join(staged, 'crossweave Cockpit.app', 'Contents', 'MacOS', 'crossweave Cockpit')
    writeExecutable(executable, '#!/bin/sh\necho new-cockpit\n')
    const zipPath = join(release, 'cockpit-darwin-arm64.zip')
    const zipped = spawnSync('python3', [
      '-m', 'zipfile', '-c', zipPath, 'crossweave Cockpit.app',
    ], { cwd: staged, encoding: 'utf8' })
    if (zipped.status !== 0) throw new Error(zipped.stderr)
    names.push('cockpit-darwin-arm64.zip')
  }

  const checksums = names.map((name) => {
    const hash = corruptCockpit && name === 'cockpit-darwin-arm64.zip'
      ? '0'.repeat(64)
      : sha256(join(release, name))
    return `${hash}  ${name}`
  })
  writeFileSync(join(release, 'checksums.txt'), `${checksums.join('\n')}\n`)
  return release
}

function runInstaller(
  system: 'Darwin' | 'Linux',
  machine: 'arm64' | 'x86_64',
  release: string,
  options: { failCockpitInstall?: boolean; failCockpitStage?: boolean; failCockpitDir?: boolean; failConfigInstall?: boolean } = {},
) {
  const home = join(root, 'home')
  const bin = join(root, 'installed-bin')
  const applications = join(root, 'Applications')
  mkdirSync(home, { recursive: true })
  const fakeBin = fakeUname(system, machine)
  if (options.failCockpitDir) {
    const failureMarker = join(root, 'mkdir-failed-once')
    writeExecutable(join(fakeBin, 'mkdir'), `#!/bin/sh
if [ "$2" = "${applications}" ] && [ ! -e "${failureMarker}" ]; then
  touch "${failureMarker}"
  exit 1
fi
exec /bin/mkdir "$@"
`)
  }
  if (options.failConfigInstall) {
    const configTarget = join(home, '.crossweave', 'config.json')
    const failureMarker = join(root, 'config-mv-failed-once')
    writeExecutable(join(fakeBin, 'mv'), `#!/bin/sh
if [ "$2" = "${configTarget}" ] && [ ! -e "${failureMarker}" ]; then
  touch "${failureMarker}"
  exit 1
fi
exec /bin/mv "$@"
`)
  }

  if (options.failCockpitInstall || options.failCockpitStage) {
    const failedSource = options.failCockpitInstall
      ? '*/cockpit/"crossweave Cockpit.app"'
      : '*/Applications/"crossweave Cockpit.app"'
    const failureMarker = join(root, 'mv-failed-once')
    writeExecutable(join(fakeBin, 'mv'), `#!/bin/sh
case "$1" in
  ${failedSource})
    if [ ! -e "${failureMarker}" ]; then
      touch "${failureMarker}"
      exit 1
    fi
    ;;
esac
exec /bin/mv "$@"
`)
  }

  const result = spawnSync('sh', [INSTALLER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      CW_INSTALL_VERSION: 'v0.0.0-test',
      CW_INSTALL_BASE_URL: `${pathToFileURL(release).href}/`,
      CW_INSTALL_DIR: bin,
      CW_COCKPIT_INSTALL_DIR: applications,
    },
  })
  return { result, bin, applications }
}

describe('install.sh Cockpit distribution', () => {
  test('macOS arm64 installs and replaces the managed Cockpit app', () => {
    const release = makeRelease('darwin-arm64')
    const applications = join(root, 'Applications')
    const existing = join(applications, 'crossweave Cockpit.app', 'Contents', 'MacOS', 'crossweave Cockpit')
    writeExecutable(existing, '#!/bin/sh\necho old-cockpit\n')

    const { result, bin } = runInstaller('Darwin', 'arm64', release)

    expect(result.status).toBe(0)
    expect(readFileSync(existing, 'utf8')).toContain('new-cockpit')
    expect(existsSync(join(bin, 'cw'))).toBe(true)
    expect(existsSync(join(bin, 'cwd'))).toBe(true)
  })


  test('macOS arm64 still installs CLI binaries from an older release with no Cockpit asset', () => {
    const release = makeRelease('darwin-arm64', { includeCockpit: false })
    const { result, bin, applications } = runInstaller('Darwin', 'arm64', release)

    expect(result.status).toBe(0)
    expect(existsSync(join(bin, 'cw'))).toBe(true)
    expect(existsSync(join(bin, 'cwd'))).toBe(true)
    expect(existsSync(join(applications, 'crossweave Cockpit.app'))).toBe(false)
  })

  test('Linux installs only the CLI and daemon without requesting a Cockpit asset', () => {
    const release = makeRelease('linux-x64')
    const { result, bin, applications } = runInstaller('Linux', 'x86_64', release)

    expect(result.status).toBe(0)
    expect(existsSync(join(bin, 'cw'))).toBe(true)
    expect(existsSync(join(bin, 'cwd'))).toBe(true)
    expect(existsSync(join(applications, 'crossweave Cockpit.app'))).toBe(false)
  })

  test('a Cockpit destination failure restores the previous installation', () => {
    const release = makeRelease('darwin-arm64')
    const bin = join(root, 'installed-bin')
    const applications = join(root, 'Applications')
    const cw = join(bin, 'cw')
    const cwd = join(bin, 'cwd')
    const cockpit = join(applications, 'crossweave Cockpit.app', 'Contents', 'MacOS', 'crossweave Cockpit')
    writeExecutable(cw, 'old-cw\n')
    writeExecutable(cwd, 'old-cwd\n')
    writeExecutable(cockpit, 'old-cockpit\n')

    const { result } = runInstaller('Darwin', 'arm64', release, { failCockpitDir: true })

    expect(result.status).not.toBe(0)
    expect(readFileSync(cw, 'utf8')).toBe('old-cw\n')
    expect(readFileSync(cwd, 'utf8')).toBe('old-cwd\n')
    expect(readFileSync(cockpit, 'utf8')).toBe('old-cockpit\n')
  })

  test('a config install failure restores the previous binaries and app', () => {
    const release = makeRelease('darwin-arm64')
    const bin = join(root, 'installed-bin')
    const applications = join(root, 'Applications')
    const cw = join(bin, 'cw')
    const cwd = join(bin, 'cwd')
    const cockpit = join(applications, 'crossweave Cockpit.app', 'Contents', 'MacOS', 'crossweave Cockpit')
    writeExecutable(cw, 'old-cw\n')
    writeExecutable(cwd, 'old-cwd\n')
    writeExecutable(cockpit, 'old-cockpit\n')

    const { result } = runInstaller('Darwin', 'arm64', release, { failConfigInstall: true })

    expect(result.status).not.toBe(0)
    expect(readFileSync(cw, 'utf8')).toBe('old-cw\n')
    expect(readFileSync(cwd, 'utf8')).toBe('old-cwd\n')
    expect(readFileSync(cockpit, 'utf8')).toBe('old-cockpit\n')
  })

  test('a failure staging the existing Cockpit leaves the whole install unchanged', () => {
    const release = makeRelease('darwin-arm64')
    const bin = join(root, 'installed-bin')
    const applications = join(root, 'Applications')
    const cw = join(bin, 'cw')
    const cwd = join(bin, 'cwd')
    const cockpit = join(applications, 'crossweave Cockpit.app', 'Contents', 'MacOS', 'crossweave Cockpit')
    writeExecutable(cw, 'old-cw\n')
    writeExecutable(cwd, 'old-cwd\n')
    writeExecutable(cockpit, 'old-cockpit\n')

    const { result } = runInstaller('Darwin', 'arm64', release, { failCockpitStage: true })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('could not stage the existing Cockpit')
    expect(readFileSync(cw, 'utf8')).toBe('old-cw\n')
    expect(readFileSync(cwd, 'utf8')).toBe('old-cwd\n')
    expect(readFileSync(cockpit, 'utf8')).toBe('old-cockpit\n')
  })

  test('a Cockpit install failure rolls back the CLI, daemon, and app together', () => {
    const release = makeRelease('darwin-arm64')
    const bin = join(root, 'installed-bin')
    const applications = join(root, 'Applications')
    const cw = join(bin, 'cw')
    const cwd = join(bin, 'cwd')
    const cockpit = join(applications, 'crossweave Cockpit.app', 'Contents', 'MacOS', 'crossweave Cockpit')
    writeExecutable(cw, 'old-cw\n')
    writeExecutable(cwd, 'old-cwd\n')
    writeExecutable(cockpit, 'old-cockpit\n')

    const { result } = runInstaller('Darwin', 'arm64', release, { failCockpitInstall: true })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('could not install Cockpit')
    expect(readFileSync(cw, 'utf8')).toBe('old-cw\n')
    expect(readFileSync(cwd, 'utf8')).toBe('old-cwd\n')
    expect(readFileSync(cockpit, 'utf8')).toBe('old-cockpit\n')
  })

  test('a bad Cockpit checksum changes neither existing binaries nor the existing app', () => {
    const release = makeRelease('darwin-arm64', { corruptCockpit: true })
    const bin = join(root, 'installed-bin')
    const applications = join(root, 'Applications')
    const cw = join(bin, 'cw')
    const cwd = join(bin, 'cwd')
    const cockpit = join(applications, 'crossweave Cockpit.app', 'Contents', 'MacOS', 'crossweave Cockpit')
    writeExecutable(cw, 'old-cw\n')
    writeExecutable(cwd, 'old-cwd\n')
    writeExecutable(cockpit, 'old-cockpit\n')

    const { result } = runInstaller('Darwin', 'arm64', release)

    expect(result.status).not.toBe(0)
    expect(readFileSync(cw, 'utf8')).toBe('old-cw\n')
    expect(readFileSync(cwd, 'utf8')).toBe('old-cwd\n')
    expect(readFileSync(cockpit, 'utf8')).toBe('old-cockpit\n')
  })
})
