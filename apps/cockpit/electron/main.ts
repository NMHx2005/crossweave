import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { connectOrStart } from '../../../src/client/rpc-client.js'
import { COCKPIT_CHANNELS, isCockpitChannel, type CockpitEvent } from './channels'
import { DaemonBridge } from './daemon-bridge'
import { findCrossweaveRoot, resolveCockpitDaemonEntry } from './daemon-entry'
import { projectRootFromAdditionalData, projectRootFromArgv, resolveLaunchProjectRoot } from './project-root'
import { switchCockpitWorkspace } from './workspace-switch'
import { pushRecent } from './recent.js'

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
  try { pushRecent(root); } catch {}
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
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const picked = await pickFolder();
            if (picked) await switchWorkspace(picked);
          },
        },
        {
          label: 'Open Recent',
          submenu: [
            {
              label: 'Clear Recent',
              click: () => {
                try { const { clearRecent } = require('./recent.js'); clearRecent(); } catch {}
              },
            },
          ],
        },
        { type: 'separator' as const },
        { role: 'close' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'close' as const },
      ],
    },
  ];
  // Keep File->Open Recent dynamic via recent.ts if available; fallback hides it
  try {
    const { buildRecentSubmenu } = require('./recent.js');
    const recent = buildRecentSubmenu((root: string) => switchWorkspace(root));
    if (recent && recent.length > 0) {
      const file = template[0] as { submenu?: unknown[] };
      const submenu = file.submenu as unknown[];
      // Replace placeholder Open Recent submenu
      const idx = submenu.findIndex((x: unknown) => (x as { label?: string }).label === 'Open Recent');
      if (idx !== -1) submenu[idx] = { label: 'Open Recent', submenu: recent };
    }
  } catch {}
  Menu.setApplicationMenu(Menu.buildFromTemplate(template as never));
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
    // Rebuild File->Open Recent so it shows immediately after switching
    try { buildMenu(); } catch {}
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
