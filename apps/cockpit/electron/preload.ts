import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { isCockpitChannel, isCockpitEvent } from './channels'

contextBridge.exposeInMainWorld('cockpit', {
  invoke(channel: string, payload?: unknown) {
    if (!isCockpitChannel(channel)) {
      return Promise.reject(new Error(`Disallowed invoke channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },
  listen(event: string, cb: (...args: unknown[]) => void) {
    if (!isCockpitEvent(event)) {
      throw new Error(`Disallowed listen event: ${event}`)
    }
    const listener = (_event: IpcRendererEvent, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(event, listener)
    return () => {
      ipcRenderer.off(event, listener)
    }
  },
})
