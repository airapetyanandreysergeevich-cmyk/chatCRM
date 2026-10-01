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
  pickBackup: () => ipcRenderer.invoke("setup:pick-backup"),
  restore: (choice) => ipcRenderer.invoke("setup:restore", choice),
  forget: () => ipcRenderer.invoke("setup:forget"),
  onProgress: (fn) => ipcRenderer.on("setup:progress", (_e, step) => fn(step)),
});

/**
 * Резервные копии для страницы «Настройки → Базы».
 *
 * Мостик отдаётся в любое окно, но главный процесс выполняет действия,
 * только если страница открыта с самой Основы (см. fromOwnWindow в main.js).
 * На компьютере сотрудника и в облаке ответ — «не здесь».
 */
contextBridge.exposeInMainWorld("finecrmDesktop", {
  backups: {
    status: () => ipcRenderer.invoke("desktop:backups-status"),
    addPlace: () => ipcRenderer.invoke("desktop:backups-add"),
    removePlace: (placePath) => ipcRenderer.invoke("desktop:backups-remove", placePath),
    runNow: () => ipcRenderer.invoke("desktop:backups-run"),
    open: (placePath) => ipcRenderer.invoke("desktop:backups-open", placePath),
  },
  // Печать через CRM: этот компьютер печатает задания мастерской (printing.js).
  printing: {
    info: () => ipcRenderer.invoke("desktop:print-info"),
    printers: () => ipcRenderer.invoke("desktop:printers"),
    print: (job) => ipcRenderer.invoke("desktop:print", job),
  },
});
