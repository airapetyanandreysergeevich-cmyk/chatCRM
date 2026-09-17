"use strict";

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const net = require("net");
const path = require("path");

const config = require("./config");
const location = require("./location");
const { ensureLayout } = require("./paths");
const { prepareMain, backendEnv, backendDir } = require("./bootstrap");
const { Backend } = require("./backend");
const { freePort } = require("./postgres");

/**
 * Оболочка локальной версии.
 *
 * Сама по себе она почти ничего не делает: поднимает базу, запускает сервер и
 * показывает в окне тот же интерфейс, что и в браузере. Так и задумано — чем
 * меньше кода живёт только в коробке, тем меньше расходятся коробка и облако.
 */

let win = null;
let tray = null;
let postgres = null;
let backend = null;
let state = { step: "старт", error: null };

const userData = () => app.getPath("userData");
const staticDir = () => path.join(process.resourcesPath || path.join(__dirname, ".."), "frontend");

// Две копии на одном компьютере подрались бы за базу: вторая не поднимется, а
// первая покажет своё окно.
if (!app.requestSingleInstanceLock()) app.quit();

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

// ------------------------------------------------------------------- окна

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0F1117",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Внешние ссылки — в браузер, а не в окно программы: вернуться из
  // случайно открытого сайта внутри окна человеку будет нечем.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", (e) => {
    // Основа продолжает работать в трее: сотрудники на других компьютерах
    // не должны терять доступ оттого, что приёмщик закрыл окно.
    if (tray && !app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  return win;
}

const showSetup = (hash) =>
  win.loadFile(path.join(__dirname, "setup.html"), hash ? { hash } : undefined);

function showError(title, message, logDir) {
  state.error = { title, message, logDir };
  win.loadFile(path.join(__dirname, "setup.html"), { hash: "error" });
}

// ------------------------------------------------------------------- запуск

/**
 * Порт сервера.
 *
 * Когда база раздаётся по сети, порт обязан быть тем же, что записан в
 * настройках: его знают клиенты. Когда не раздаётся — берём любой свободный,
 * чтобы не спорить с чужими программами за 7373.
 */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function choosePort(cfg) {
  if (await portFree(cfg.share.port)) return cfg.share.port;
  if (cfg.share.enabled) {
    throw new Error(
      `Порт ${cfg.share.port} занят другой программой. Освободите его или укажите другой в настройках — ` +
        "клиенты в сети ищут Основу именно на нём."
    );
  }
  return freePort();
}

/** Запуск в роли Основы: база, миграции, сервер, окно. */
async function startMain(dataDir) {
  const say = (step) => {
    state.step = step;
    if (win && !win.isDestroyed()) win.webContents.send("setup:progress", step);
  };

  const prepared = await prepareMain(dataDir, say);
  const cfg = prepared.config;
  postgres = prepared.postgres;

  say("Запускаю сервер");
  const port = await choosePort(cfg);
  const l = ensureLayout(dataDir);

  backend = new Backend({
    dir: backendDir(),
    port,
    logDir: l.logs,
    env: { ...backendEnv(cfg, l), PORT: String(port), STATIC_DIR: staticDir() },
  });

  backend.onExit = (code) => {
    if (app.isQuitting) return;
    showError(
      "Сервер остановился",
      `Программа завершила работу с кодом ${code}. Перезапустите её; если повторится — пришлите журнал.`,
      l.logs
    );
  };

  await backend.start();

  if (tray) tray.setToolTip(`FineCRM — Основа, порт ${port}`);
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

/** Запуск в роли клиента: ничего не поднимаем, просто открываем адрес. */
async function startClient(url) {
  await win.loadURL(url);
}

async function boot() {
  const where = location.readLocation(userData());

  if (!where) {
    await showSetup();
    return;
  }

  try {
    if (where.mode === config.MODE.MAIN) {
      // Сразу показываем экран подготовки, а не выбор роли: роль уже выбрана,
      // и предлагать её снова при каждом запуске незачем.
      await showSetup("working");
      await startMain(where.dataDir);
    } else {
      await startClient(where.connectTo);
    }
  } catch (err) {
    const logs = where.dataDir ? ensureLayout(where.dataDir).logs : userData();
    showError("Не удалось запуститься", err.message, logs);
  }
}

// ------------------------------------------------------------------- трей

function createTray() {
  const icon = path.join(__dirname, "..", "build", "icon.png");
  if (!fs.existsSync(icon)) return null;

  tray = new Tray(icon);
  tray.setToolTip("FineCRM");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Открыть", click: () => (win.isVisible() ? win.focus() : win.show()) },
      { type: "separator" },
      { label: "Выйти", click: () => app.quit() },
    ])
  );
  tray.on("double-click", () => win.show());
  return tray;
}

// -------------------------------------------------------------- обмен с окном

ipcMain.handle("setup:state", () => ({
  step: state.step,
  error: state.error,
  modes: config.MODE,
  suggestedDir: path.join(app.getPath("documents"), "FineCRM"),
}));

ipcMain.handle("setup:pick-folder", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Где хранить базу мастерской",
    properties: ["openDirectory", "createDirectory"],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("setup:check-folder", (_e, dir) => location.checkDataDir(dir));

ipcMain.handle("setup:open-logs", (_e, dir) => shell.openPath(dir));

/** Выбор сделан: запоминаем и поднимаемся. */
ipcMain.handle("setup:apply", async (_e, choice) => {
  try {
    if (choice.mode === config.MODE.MAIN) {
      const check = location.checkDataDir(choice.dataDir);
      if (!check.ok) return { ok: false, error: check.reason };

      location.writeLocation(userData(), { mode: config.MODE.MAIN, dataDir: check.path });
      await startMain(check.path);
    } else {
      // Клиент базу не трогает вовсе. Проверяем, что Основа отвечает, — иначе
      // человек получит пустое окно и не поймёт, кто виноват.
      const url = String(choice.connectTo || "").replace(/\/+$/, "");
      const res = await fetch(`${url}/api/health`).catch(() => null);
      if (!res || !res.ok) {
        return { ok: false, error: `По адресу ${url} никто не отвечает. Проверьте, включена ли Основа.` };
      }
      location.writeLocation(userData(), { mode: choice.mode, connectTo: url });
      await startClient(url);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ------------------------------------------------------------------- жизнь

app.whenReady().then(async () => {
  createWindow();
  createTray();
  await boot();
});

app.on("before-quit", () => {
  app.isQuitting = true;
});

app.on("window-all-closed", () => {
  if (!tray) app.quit();
});

// Гасим по порядку: сначала сервер, потом база. Наоборот — сервер успеет
// пожаловаться на пропавшую базу и напишет в журнал десяток ошибок на пустом месте.
app.on("quit", async () => {
  try {
    if (backend) await backend.stop();
    if (postgres) await postgres.stop();
  } catch {
    /* выключаемся в любом случае */
  }
});

module.exports = { startMain, startClient };
