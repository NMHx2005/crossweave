import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { isCockpitChannel, isCockpitEvent } from './channels'

contextBridge.exposeInMainWorld('cockpit', {
  // A File dropped from Finder has no path in the renderer; only the preload can ask
  // Electron for it. Returns '' for a File that is not on disk (e.g. dragged from a page).
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  invoke(channel: string, payload?: unknown) {
    if (!isCockpitChannel(channel)) {
      return Promise.reject(new Error(`Disallowed invoke channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },
  listen(event: string, cb: (payload: unknown) => void) {
    if (!isCockpitEvent(event)) {
      throw new Error(`Disallowed listen event: ${event}`)
    }
    const listener = (_event: IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(event, listener)
    return () => {
      ipcRenderer.off(event, listener)
    }
  },
})
