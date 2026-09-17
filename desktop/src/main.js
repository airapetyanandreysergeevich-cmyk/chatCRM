"use strict";

const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const config = require("./config");
const location = require("./location");
const { ensureLayout, backendDir, frontendDir } = require("./paths");
const { prepareMain, backendEnv } = require("./bootstrap");
const { Backend } = require("./backend");
const { freePort } = require("./postgres");
const { Backups } = require("./backup");
const network = require("./network");

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
let backups = null;
/** Что сейчас поднято: настройки, раскладка папки, порт сервера. */
let running = null;
/** Пока сервер перезапускают намеренно, его уход — не повод пугать человека. */
let restartingBackend = false;
let state = { step: "старт", error: null };

const userData = () => app.getPath("userData");

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

function showError(title, message, logDir, extra = {}) {
  state.error = { title, message, logDir, ...extra };
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
async function startMain(dataDir, owner = null) {
  const say = (step) => {
    state.step = step;
    if (win && !win.isDestroyed()) win.webContents.send("setup:progress", step);
  };

  const prepared = await prepareMain(dataDir, say, owner);
  const cfg = prepared.config;
  postgres = prepared.postgres;

  say("Запускаю сервер");
  const l = ensureLayout(dataDir);
  const port = await startBackend(cfg, l);

  // Копии заводим только у Основы и только после того, как база поднялась:
  // это единственный компьютер, где данные действительно лежат.
  backups = new Backups({ layout: l, config: cfg, binDir: postgres.binDir });
  backups.start((report) => {
    if (!report.ok) {
      dialog.showMessageBox(win, {
        type: "warning",
        title: "Резервная копия не сделана",
        message: report.error,
        detail: "Данные в порядке, но копии за сегодня нет. Проверьте, доступна ли папка для копий.",
      });
    }
    refreshTray();
  });
  refreshTray();

  await win.loadURL(`http://127.0.0.1:${port}/`);

  // После окна, а не до: предупреждение о сети не должно задерживать запуск
  // программы на том компьютере, где она и так работает.
  void warnIfNetworkBlocks();
}

/**
 * Поднимает сервер и запоминает, на чём именно.
 *
 * Вынесено отдельно, потому что вызывается дважды: при старте и при включении
 * раздачи по сети — там сервер приходится поднять заново, уже на другом
 * адресе прослушивания.
 */
async function startBackend(cfg, l) {
  const port = await choosePort(cfg);

  backend = new Backend({
    dir: backendDir(),
    port,
    logDir: l.logs,
    env: { ...backendEnv(cfg, l), PORT: String(port), STATIC_DIR: frontendDir() },
  });

  backend.onExit = (code) => {
    if (app.isQuitting || restartingBackend) return;
    showError(
      "Сервер остановился",
      `Программа завершила работу с кодом ${code}. Перезапустите её; если повторится — пришлите журнал.`,
      l.logs
    );
  };

  await backend.start();
  running = { cfg, layout: l, port };
  return port;
}

/**
 * Включает или выключает раздачу базы по локальной сети.
 *
 * Пока раздача выключена, сервер слушает только сам компьютер — программа в
 * мастерской не должна становиться доступной всему кафе оттого, что ноутбук
 * воткнули в чужой вайфай. Включение — осознанное действие владельца.
 */
async function toggleSharing() {
  if (!running) return;
  const { cfg, layout: l } = running;
  const turningOn = !cfg.share.enabled;

  restartingBackend = true;
  try {
    await backend.stop();
    cfg.share.enabled = turningOn;
    config.write(l.config, cfg);
    const port = await startBackend(cfg, l);

    refreshTray();
    await dialog.showMessageBox(win, {
      type: "info",
      title: turningOn ? "Раздача включена" : "Раздача выключена",
      message: turningOn
        ? `Сотрудники подключаются по адресу ${lanAddress(port)}`
        : "Программа снова доступна только на этом компьютере.",
      detail: turningOn
        ? "Впишите этот адрес на другом компьютере при выборе роли «Клиент». " +
          "Если он не откроется — брандмауэр Windows не пропускает входящие на этот порт."
        : undefined,
    });
    if (turningOn) await warnIfNetworkBlocks();
  } catch (err) {
    // Откатываем настройку: раздача, которую не удалось включить, не должна
    // остаться записанной как включённая.
    cfg.share.enabled = !turningOn;
    config.write(l.config, cfg);
    dialog.showMessageBox(win, { type: "error", title: "Не получилось", message: err.message });
  } finally {
    restartingBackend = false;
  }
}

/** Адрес этого компьютера в локальной сети — тот, что вводят сотрудники. */
function lanAddress(port) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      // Только IPv4 и только настоящие сетевые карты: внутренние и виртуальные
      // адреса сотрудникам ничем не помогут.
      if (net.family === "IPv4" && !net.internal) return `http://${net.address}:${port}`;
    }
  }
  return `http://127.0.0.1:${port}`;
}

/** Запуск в роли клиента: ничего не поднимаем, просто открываем адрес. */
async function startClient(url) {
  const address = String(url).replace(/\/+$/, "");

  // Показываем ожидание сразу: пустое окно на время проверки — ровно то, от
  // чего мы здесь и уходим.
  await showSetup("working");
  state.step = "Ищу Основу в сети";
  if (win && !win.isDestroyed()) win.webContents.send("setup:progress", state.step);

  const answer = await network.reach(address);
  if (!answer.ok) {
    showError("Основа не отвечает", answer.why, null, { kind: "client", address });
    return;
  }

  await win.loadURL(address);
}

/**
 * Предупреждает, когда сеть помечена общедоступной.
 *
 * В такой сети брандмауэр не применяет правило, открывающее порт Основы, и
 * сотрудники получают пустое окно. Ошибки при этом не видит никто: на Основе
 * всё работает. Поэтому спрашиваем сами — и умеем починить.
 */
async function warnIfNetworkBlocks() {
  if (!running || !running.cfg.share.enabled) return;

  const closed = await network.blocking();
  if (closed.length === 0) return;

  const names = closed.map((p) => `«${p.name}»`).join(", ");
  const answer = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Сотрудники не увидят Основу",
    message: `Windows считает сеть ${names} общедоступной.`,
    detail:
      "В общедоступной сети брандмауэр не пропускает обращения к Основе, и на других компьютерах программа " +
      "будет открываться пустым окном. Сеть мастерской нужно пометить частной — это одно действие, Windows " +
      "спросит права администратора. В кафе и гостинице этого делать не стоит.",
    buttons: ["Сделать сеть частной", "Не сейчас"],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response !== 0) return;

  try {
    await network.makePrivate(closed.map((p) => p.index));
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: "error",
      title: "Не получилось пометить сеть частной",
      message: err.message,
      detail: "Это можно сделать вручную: Параметры → Сеть и Интернет → нужная сеть → «Частная сеть».",
    });
  }
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
  tray.on("double-click", () => win.show());
  refreshTray();
  return tray;
}

/** Когда была последняя копия — человеческими словами. */
function lastBackupLabel() {
  const b = backups && backups.config.backup;
  if (!b || !b.lastAt) return "Копий ещё не было";
  const when = new Date(b.lastAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
  return b.lastOk ? `Последняя копия: ${when}` : `Копия не удалась: ${when}`;
}

/**
 * Меню в трее. Пересобираем целиком, а не правим пункты: Electron не даёт
 * менять готовое меню, и «обновлённый» пункт остался бы прежним.
 */
function refreshTray() {
  if (!tray) return;

  tray.setToolTip("FineCRM — Основа");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Открыть", click: () => (win.isVisible() ? win.focus() : win.show()) },
      { type: "separator" },
      {
        label: "Раздавать базу по сети",
        type: "checkbox",
        checked: !!(running && running.cfg.share.enabled),
        enabled: !!running,
        click: () => void toggleSharing(),
      },
      ...(running && running.cfg.share.enabled
        ? [
            { label: `Адрес: ${lanAddress(running.port)}`, enabled: false },
            {
              label: "Скопировать адрес",
              click: () => clipboard.writeText(lanAddress(running.port)),
            },
          ]
        : []),
      { type: "separator" },
      { label: lastBackupLabel(), enabled: false },
      {
        label: "Сделать копию сейчас",
        enabled: !!backups,
        click: async () => {
          const report = await backups.run("вручную");
          refreshTray();
          dialog.showMessageBox(win, {
            type: report.ok ? "info" : "error",
            title: report.ok ? "Копия готова" : "Копию сделать не удалось",
            message: report.ok
              ? `${Math.round(report.bytes / 1024)} КБ, таблиц: ${report.tables}`
              : report.error,
            detail: report.ok ? report.file : "Проверьте, доступна ли папка для копий.",
          });
        },
      },
      { type: "separator" },
      { label: "Выйти", click: () => app.quit() },
    ])
  );
}

// -------------------------------------------------------------- обмен с окном

ipcMain.handle("setup:state", () => ({
  step: state.step,
  error: state.error,
  modes: config.MODE,
  suggestedDir: location.suggestDataDir({
    home: app.getPath("home"),
    documents: app.getPath("documents"),
  }),
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

/**
 * Повторить попытку.
 *
 * Раньше кнопка «Попробовать снова» просто перезагружала страницу — и человек
 * видел ту же ошибку, ничего на деле не повторив. Теперь она проходит весь
 * путь запуска заново: за минуту, что человек читал сообщение, он успел
 * включить раздачу на Основе или починить сеть.
 */
ipcMain.handle("setup:retry", async () => {
  state.error = null;
  await boot();
  return { ok: true };
});

/** Забыть выбор и вернуться к экрану роли — когда адрес Основы оказался не тот. */
ipcMain.handle("setup:forget", async () => {
  location.forgetLocation(userData());
  state.error = null;
  await showSetup();
  return { ok: true };
});

/** Выбор сделан: запоминаем и поднимаемся. */
ipcMain.handle("setup:apply", async (_e, choice) => {
  try {
    if (choice.mode === config.MODE.MAIN) {
      const check = location.checkDataDir(choice.dataDir);
      if (!check.ok) return { ok: false, error: check.reason };

      location.writeLocation(userData(), { mode: config.MODE.MAIN, dataDir: check.path });
      await startMain(check.path, choice.owner ?? null);
    } else {
      // Клиент базу не трогает вовсе. Проверяем, что Основа отвечает, — иначе
      // человек получит пустое окно и не поймёт, кто виноват.
      const url = String(choice.connectTo || "").replace(/\/+$/, "");
      const answer = await network.reach(url);
      if (!answer.ok) return { ok: false, error: answer.why };
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

/**
 * Выключение.
 *
 * Обязательно здесь, а не в событии quit: Electron не ждёт асинхронную
 * работу в quit и завершает процесс раньше, чем успеет остановиться база.
 * Последствия у этого нехорошие — postgres остаётся жить сиротой, держит
 * папку и порт, и следующий запуск упирается в собственный вчерашний
 * процесс. Поэтому перехватываем выход, гасим по-честному и только потом
 * выходим сами.
 */
let shuttingDown = false;

app.on("before-quit", (e) => {
  app.isQuitting = true;
  if (shuttingDown) return;

  e.preventDefault();
  shuttingDown = true;

  // Сначала сервер, потом база: наоборот сервер успеет написать десяток
  // жалоб на пропавшую базу.
  (async () => {
    try {
      if (backups) backups.stop();
      if (backend) await backend.stop();
      if (postgres) await postgres.stop();
    } catch {
      /* выключаемся в любом случае */
    }
    app.exit(0);
  })();
});

app.on("window-all-closed", () => {
  if (!tray) app.quit();
});

module.exports = { startMain, startClient };
