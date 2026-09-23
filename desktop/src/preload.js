"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * Мостик между окном первого запуска и программой.
 *
 * Наружу отдаём наперечёт действия и ни одного модуля Node: окно показывает
 * веб-страницу, и страница не должна уметь ничего, кроме того, что ей нужно.
 */
contextBridge.exposeInMainWorld("setup", {
  state: () => ipcRenderer.invoke("setup:state"),
  pickFolder: () => ipcRenderer.invoke("setup:pick-folder"),
  checkFolder: (dir) => ipcRenderer.invoke("setup:check-folder", dir),
  discover: (opts) => ipcRenderer.invoke("setup:discover", opts || {}),
  onDiscoverStep: (fn) => ipcRenderer.on("setup:discover-step", (_e, step) => fn(step)),
  apply: (choice) => ipcRenderer.invoke("setup:apply", choice),
  openLogs: (dir) => ipcRenderer.invoke("setup:open-logs", dir),
  retry: () => ipcRenderer.invoke("setup:retry"),
  forget: () => ipcRenderer.invoke("setup:forget"),
  onProgress: (fn) => ipcRenderer.on("setup:progress", (_e, step) => fn(step)),
});
