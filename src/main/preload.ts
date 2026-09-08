import { contextBridge, ipcRenderer } from "electron";
import type { ClientBridge, ClientEvent } from "../shared/types";

const bridge: ClientBridge = {
  mode: "desktop",
  command: (command) => ipcRenderer.invoke("wayfarer:command", command),
  asset: (url) => ipcRenderer.invoke("wayfarer:asset", url),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ClientEvent) =>
      listener(payload);
    ipcRenderer.on("wayfarer:event", handler);
    return () => ipcRenderer.removeListener("wayfarer:event", handler);
  },
};
contextBridge.exposeInMainWorld("wayfarer", bridge);
