import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { connectOrStart } from '../../../src/client/rpc-client.js'
import { COCKPIT_CHANNELS, isCockpitChannel, type CockpitEvent } from './channels'
import { DaemonBridge } from './daemon-bridge'
import { findCrossweaveRoot, resolveCockpitDaemonEntry } from './daemon-entry'
import { projectRootFromAdditionalData, projectRootFromArgv, resolveLaunchProjectRoot } from './project-root'
import { switchCockpitWorkspace } from './workspace-switch'
import { clearRecent, loadRecent, pushRecent } from './recent.js'
import { recentMenuItems } from './recent-menu'
import { appMenuTemplate } from './app-menu'
import { editorLaunch, resolveLinkTarget } from './editor-open'
import { loadSettings } from '../../../src/core/settings.js'

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
  // Rebuilt here, after the push, so Open Recent lists the folder just opened. It
  // used to be rebuilt before the switch had persisted anything, one switch behind.
  try {
    pushRecent(root)
    buildMenu()
  } catch {}
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

function buildMenu(): void {
  const template = appMenuTemplate({
    platform: process.platform,
    command: (name) => sendToRenderers('cockpit.command', { command: name }),
    openFolder: () => {
      void pickFolder().then((picked) => {
        if (picked) void switchWorkspace(picked)
      })
    },
    recent: recentMenuItems(loadRecent(), {
      exists: existsSync,
      home: app.getPath('home'),
      open: (root) => { void switchWorkspace(root) },
      clear: () => {
        clearRecent()
        buildMenu()
      },
    }),
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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

/**
 * Open a file a session's output linked to, in the user's editor. The worktree comes
 * from the daemon's own session list — not from the renderer — and the target must be
 * an existing file inside it (resolveLinkTarget).
 */
async function openInEditor(bridge: DaemonBridge, payload: unknown): Promise<{ ok: boolean }> {
  const p = (payload ?? {}) as { sessionId?: unknown; path?: unknown; line?: unknown; col?: unknown }
  if (typeof p.sessionId !== 'string' || typeof p.path !== 'string') return { ok: false }
  const sessions = await bridge.handle('session.list') as Array<{ id: string; worktreePath?: string | null }>
  const worktree = sessions.find((s) => s.id === p.sessionId)?.worktreePath
  if (typeof worktree !== 'string') return { ok: false }
  const file = resolveLinkTarget(worktree, p.path)
  if (file === null) return { ok: false }
  const line = typeof p.line === 'number' && p.line > 0 ? p.line : 1
  const col = typeof p.col === 'number' && p.col > 0 ? p.col : 1
  const launch = editorLaunch(loadSettings().editor, file, line, col)
  if (launch.kind === 'url') {
    await shell.openExternal(launch.url)
  } else {
    const [command, ...args] = launch.argv
    if (command === undefined) return { ok: false }
    execFile(command, args, () => undefined)
  }
  return { ok: true }
}

function registerHandlers(bridge: DaemonBridge): void {
  for (const channel of COCKPIT_CHANNELS) {
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      if (!isCockpitChannel(channel)) {
        throw new Error(`Disallowed invoke channel: ${channel}`)
      }
      if (channel === 'editor.open') return openInEditor(bridge, payload)
      return bridge.handle(channel, payload)
    })
  }
}

function createWindow(): BrowserWindow {
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
  return win
}

let bridge: DaemonBridge | undefined
let pendingProjectRoot: string | undefined

async function switchWorkspace(projectRoot: string): Promise<void> {
  if (!bridge) {
    pendingProjectRoot = projectRoot
    return
  }

  try {
    await switchCockpitWorkspace(projectRoot, {
      ensure: async (root) => {
        await bridge?.handle('workspace.ensure', { projectRoot: root })
      },
      recreateWindow: () => {
        for (const win of BrowserWindow.getAllWindows()) win.destroy()
        return createWindow()
      },
    })
  } catch (err) {
    console.error('workspace switch failed:', err)
  }
}

const initialProjectRoot = resolveLaunchProjectRoot(process.argv, process.env.COCKPIT_PROJECT_ROOT)
const hasSingleInstanceLock = app.requestSingleInstanceLock(
  initialProjectRoot ? { projectRoot: initialProjectRoot } : {},
)
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    const projectRoot = projectRootFromAdditionalData(additionalData) ?? projectRootFromArgv(argv)
    if (projectRoot !== undefined) void switchWorkspace(projectRoot)
  })

  app.whenReady().then(async () => {
    buildMenu()
    bridge = createBridge()
    registerHandlers(bridge)
    createWindow()

    const launchRoot = pendingProjectRoot ?? initialProjectRoot
    pendingProjectRoot = undefined
    try {
      await bridge.handle('workspace.ensure', launchRoot ? { projectRoot: launchRoot } : undefined)
    } catch (err) {
      console.error('workspace.ensure failed:', err)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  bridge?.close()
})
