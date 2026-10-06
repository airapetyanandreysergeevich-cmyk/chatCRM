"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * Панель окна площадок (markets.html). Страницам самих площадок мостик не
 * даётся вовсе — они открыты в отдельном виде без preload.
 */
contextBridge.exposeInMainWorld("markets", {
  state: () => ipcRenderer.invoke("markets:state"),
  tab: (shop) => ipcRenderer.invoke("markets:tab", shop),
  nav: (what) => ipcRenderer.invoke("markets:nav", what),
  collect: () => ipcRenderer.invoke("markets:collect"),
  onState: (fn) => ipcRenderer.on("markets:state", (_e, s) => fn(s)),
  onNotice: (fn) => ipcRenderer.on("markets:notice", (_e, n) => fn(n)),
});
