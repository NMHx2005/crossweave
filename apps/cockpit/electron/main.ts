import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { connectOrStart } from '../../../src/client/rpc-client.js'
import { COCKPIT_CHANNELS, isCockpitChannel, type CockpitEvent } from './channels'
import { DaemonBridge } from './daemon-bridge'
import { findCrossweaveRoot, resolveCockpitDaemonEntry } from './daemon-entry'

const __dirname = dirname(fileURLToPath(import.meta.url))

function savedRootPath(): string {
  return join(app.getPath('userData'), 'project-root.json')
}

function loadSavedRoot(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(savedRootPath(), 'utf8')) as { projectRoot?: unknown }
    return typeof parsed.projectRoot === 'string' ? parsed.projectRoot : undefined
  } catch {
    return undefined
  }
}

function saveRoot(root: string): void {
  const file = savedRootPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ projectRoot: root })}\n`)
}

function sendToRenderers(event: CockpitEvent, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, payload)
  }
}

async function pickFolder(): Promise<string | undefined> {
  const parent = BrowserWindow.getAllWindows()[0]
  const options = {
    title: 'Open crossweave project',
    properties: ['openDirectory' as const],
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled) return undefined
  return result.filePaths[0]
}

function resolveBunCommand(): string {
  if (process.env.BUN) return process.env.BUN
  try {
    return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
  } catch {
    return 'bun'
  }
}

function createBridge(): DaemonBridge {
  const entry = app.isPackaged
    ? resolveCockpitDaemonEntry('', '', { isPackaged: true })
    : resolveCockpitDaemonEntry(findCrossweaveRoot(__dirname), resolveBunCommand())
  return new DaemonBridge({
    connect: (projectRoot) => connectOrStart(projectRoot, entry),
    pickFolder,
    loadSavedRoot,
    saveRoot,
    exists: existsSync,
    send: sendToRenderers,
  })
}

function registerHandlers(bridge: DaemonBridge): void {
  for (const channel of COCKPIT_CHANNELS) {
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      if (!isCockpitChannel(channel)) {
        throw new Error(`Disallowed invoke channel: ${channel}`)
      }
      return bridge.handle(channel, payload)
    })
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 480,
    title: 'crossweave Cockpit',
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'))
  }
}

let bridge: DaemonBridge | undefined

app.whenReady().then(async () => {
  bridge = createBridge()
  registerHandlers(bridge)
  createWindow()

  const envRoot = process.env.COCKPIT_PROJECT_ROOT
  try {
    await bridge.handle('workspace.ensure', envRoot ? { projectRoot: envRoot } : undefined)
  } catch (err) {
    console.error('workspace.ensure failed:', err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  bridge?.close()
})
