"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * Мостик между окном первого запуска и программой.
 *
 * Наружу отдаём ровно пять действий и ни одного модуля Node: окно показывает
 * веб-страницу, и страница не должна уметь ничего, кроме того, что ей нужно.
 */
contextBridge.exposeInMainWorld("setup", {
  state: () => ipcRenderer.invoke("setup:state"),
  pickFolder: () => ipcRenderer.invoke("setup:pick-folder"),
  checkFolder: (dir) => ipcRenderer.invoke("setup:check-folder", dir),
  apply: (choice) => ipcRenderer.invoke("setup:apply", choice),
  openLogs: (dir) => ipcRenderer.invoke("setup:open-logs", dir),
  onProgress: (fn) => ipcRenderer.on("setup:progress", (_e, step) => fn(step)),
});
