"use strict";

const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const config = require("./config");
const location = require("./location");
const { ensureLayout, backendDir, frontendDir, ocrModelsDir } = require("./paths");
const { prepareMain, backendEnv } = require("./bootstrap");
const { Backend } = require("./backend");
const { freePort } = require("./postgres");
const { Backups } = require("./backup");
const network = require("./network");
const discovery = require("./discovery");
const { Updater } = require("./updater");

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
/** Ответ на поиск Основы в сети (см. discovery.js). */
let responder = null;
/** Что сейчас поднято: настройки, раскладка папки, порт сервера. */
let running = null;
/** Пока сервер перезапускают намеренно, его уход — не повод пугать человека. */
let restartingBackend = false;
let state = { step: "старт", error: null };
/** Обновления программы через интернет (см. updater.js). */
let updater = null;
/** Окно «устанавливаем обновление» — живёт от начала установки до выхода. */
let installWin = null;

const userData = () => app.getPath("userData");

// Две копии на одном компьютере подрались бы за базу: вторая не поднимется, а
// первая покажет своё окно.
if (!app.requestSingleInstanceLock()) app.quit();

// Камера для шильдиков на компьютерах сотрудников. Они открывают Основу по
// сетевому адресу (http://192.168…), а браузер даёт камеру только надёжным
// адресам — https или своему компьютеру. Адрес Основы программа знает сама
// и считает его надёжным; ключ задаётся до запуска окна, иначе не действует.
try {
  const saved = JSON.parse(fs.readFileSync(path.join(userData(), "location.json"), "utf8"));
  if (saved && saved.mode === config.MODE.CLIENT && typeof saved.connectTo === "string") {
    app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", new URL(saved.connectTo).origin);
  }
} catch {
  // Первый запуск или адрес не задан — камеры по сети просто не будет.
}

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
  const l = ensureLayout(dataDir);

  // Основа раздаёт базу всегда. Раньше раздачу включали руками, чтобы
  // ноутбук с Основой в чужом Wi-Fi не был виден соседям, — но эту защиту и
  // так даёт Windows: правило брандмауэра открыто только для частных сетей, а
  // в общедоступной входящие отсекаются. Выключатель же стоил каждой
  // мастерской одного обязательного похода в меню, о котором все забывали.
  if (!cfg.share.enabled) {
    cfg.share.enabled = true;
    config.write(l.config, cfg);
  }

  say("Запускаю сервер");
  const port = await startBackend(cfg, l);

  // Отвечаем на поиск: сотрудник при установке нажимает «Найти
  // автоматически», и программа находит эту Основу сама.
  if (!responder) {
    responder = discovery.startResponder({
      port,
      log: (line) => console.log(`[поиск в сети] ${line}`),
    });
  }

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
    env: {
      ...backendEnv(cfg, l),
      PORT: String(port),
      STATIC_DIR: frontendDir(),
      // Распознавание шильдиков в окне программы. Нет моделей — нет кнопки.
      ...(ocrModelsDir() ? { OCR_MODELS_DIR: ocrModelsDir() } : {}),
    },
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

/**
 * Запуск без своей базы: ничего не поднимаем, просто открываем адрес.
 *
 * Два случая, и различать их надо не ради слов. У клиента локальной сети
 * молчание почти всегда означает брандмауэр или выключенную раздачу, и адрес
 * человек вводил сам — значит, его можно изменить. У облака адрес наш, менять
 * его нечего, а молчание означает интернет. Один и тот же совет в обоих
 * случаях был бы в одном из них заведомо неверным.
 */
async function startClient(url, online = false, workshopId = null) {
  let address = online ? config.CLOUD_URL : String(url).replace(/\/+$/, "");

  // Показываем ожидание сразу: пустое окно на время проверки — ровно то, от
  // чего мы здесь и уходим.
  await showSetup("working");
  state.step = online ? "Соединяюсь с облаком" : "Ищу Основу в сети";
  if (win && !win.isDestroyed()) win.webContents.send("setup:progress", state.step);

  let answer = await network.reach(address);

  // Роутер выдал Основе другой адрес — самая частая поломка у сотрудников:
  // вчера работало, сегодня пустое окно. Если мы знаем, какую мастерскую
  // искать, ищем её по номеру и молча переходим на новый адрес.
  if (!answer.ok && !online && workshopId && discovery.isLanAddress(address)) {
    state.step = "Основа сменила адрес — ищу её в сети";
    if (win && !win.isDestroyed()) win.webContents.send("setup:progress", state.step);
    const found = (await discovery.discover().catch(() => [])).find((f) => f.id === workshopId);
    if (found) {
      address = found.address;
      location.writeLocation(userData(), { mode: config.MODE.CLIENT, connectTo: address, workshopId });
      answer = await network.reach(address);
    }
  }

  if (!answer.ok) {
    if (online) {
      showError(
        "Облако не отвечает",
        `Не удалось соединиться с ${config.CLOUD_URL}. Проверьте интернет на этом компьютере: ` +
          "адрес облака программа знает сама, ошибиться в нём нельзя.",
        null,
        { kind: "online", address }
      );
    } else {
      showError("Основа не отвечает", answer.why, null, { kind: "client", address });
    }
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
      await startClient(where.connectTo, where.mode === config.MODE.ONLINE, where.workshopId ?? null);
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
      // Раздача включена всегда, поэтому здесь не выключатель, а то, что
      // может понадобиться: адрес на случай, если автопоиск у сотрудника
      // не сработает (гостевой Wi-Fi, другая подсеть).
      ...(running
        ? [
            { label: `Адрес для сотрудников: ${lanAddress(running.port)}`, enabled: false },
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
      { label: `Версия ${app.getVersion()}`, enabled: false },
      {
        label: "Проверить обновления",
        enabled: !!updater,
        click: () => void (updater && updater.check({ manual: true })),
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
  cloudUrl: config.CLOUD_URL,
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

/**
 * Найти Основу в сети — кнопка «Найти автоматически».
 *
 * Шаги поиска отправляем в окно: перебор адресов занимает несколько секунд,
 * и молчащая крутилка на это время выглядит зависшей программой.
 */
ipcMain.handle("setup:discover", async () => {
  const send = (step) => win && !win.isDestroyed() && win.webContents.send("setup:discover-step", step);
  try {
    const found = await discovery.discover({ onStep: send });
    const nets = discovery.lanInterfaces();
    const closed = await network.blocking().catch(() => []);
    return {
      found: found.map((f) => ({ address: f.address, name: f.name, id: f.id })),
      // Почему могло не найтись — чтобы подсказать по делу, а не вообще.
      noNetwork: nets.length === 0,
      publicNetwork: closed.map((p) => p.name),
    };
  } catch (err) {
    return { found: [], error: err.message, noNetwork: false, publicNetwork: [] };
  }
});

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
      // У облака адрес один и тот же, и берём мы его у себя, а не из окна:
      // пришедшее оттуда значение здесь нечему проверять, а ошибиться в
      // букве — есть чему.
      // Адрес бывает двух видов: в локальной сети (http://192.168.1.40:7373)
      // и из интернета (https://<сайт>/b/<код>/) — его владелец берёт
      // в своих настройках. Хвостовой слэш снимаем: к адресу потом клеится
      // путь, а «…/b/код//api/health» — уже не тот адрес.
      const url =
        choice.mode === config.MODE.ONLINE
          ? config.CLOUD_URL
          : String(choice.connectTo || "").trim().replace(/\/+$/, "");
      const answer = await network.reach(url);
      if (!answer.ok) return { ok: false, error: answer.why };
      // Номер мастерской помним, чтобы при смене адреса найти её снова.
      const workshopId = typeof choice.workshopId === "string" && choice.workshopId ? choice.workshopId : null;
      location.writeLocation(userData(), { mode: choice.mode, connectTo: url, workshopId });
      await startClient(url, choice.mode === config.MODE.ONLINE, workshopId);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ------------------------------------------------------------------- жизнь

/**
 * Сказать, что обновление состоялось.
 *
 * Установка идёт молча и заканчивается тем, что программа просто запускается
 * заново. Со стороны это ничем не отличается от обычного запуска, и человек
 * остаётся в сомнении, обновилось оно или нет. Поэтому номер версии
 * запоминается и при первом запуске новой показывается уведомление.
 */
function noticeIfUpdated() {
  const file = path.join(userData(), "version.json");
  const now = app.getVersion();
  let before = null;
  try {
    before = JSON.parse(fs.readFileSync(file, "utf8")).version;
  } catch {
    // Первый запуск после установки — сравнивать не с чем.
  }
  try {
    if (before !== now) fs.writeFileSync(file, JSON.stringify({ version: now }));
  } catch {
    /* не записалось — в следующий раз просто не будет уведомления */
  }
  if (!before || before === now) return;
  notify("FineCRM обновлён", `Установлена версия ${now}. База заказов и настройки на месте.`);
}

/** Уведомление Windows: в отличие от окна, оно переживает выход программы. */
function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {
    /* уведомления выключены в системе — не беда */
  }
}

/**
 * Окно на время установки обновления.
 *
 * Показывается до резервной копии и остаётся до самого выхода: дальше
 * работает установщик, а от программы уже ничего не зависит. Уведомление
 * дублирует его текстом, который останется в центре уведомлений Windows,
 * когда окно исчезнет вместе с программой.
 */
function showInstalling(version) {
  notify("FineCRM обновляется", "Программа закроется примерно на минуту и запустится сама.");
  if (installWin && !installWin.isDestroyed()) return;
  installWin = new BrowserWindow({
    width: 480,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: "Обновление FineCRM",
    backgroundColor: "#0F1117",
    autoHideMenuBar: true,
  });
  installWin.setMenu(null);
  void installWin.loadFile(path.join(__dirname, "installing.html"), {
    search: `v=${encodeURIComponent(version || app.getVersion())}`,
  });
}

/** Установка не состоялась: окно убираем, программа работает дальше. */
function hideInstalling() {
  if (installWin && !installWin.isDestroyed()) installWin.close();
  installWin = null;
}

app.whenReady().then(async () => {
  createWindow();
  noticeIfUpdated();
  createTray();
  startUpdater();
  await boot();
});

// ------------------------------------------------------------- обновления

/**
 * Обновления включаются только в собранной программе: при запуске из
 * репозитория (`electron .`) обновлять нечего — и незачем пугать
 * разработчика окнами про версию.
 */
function startUpdater() {
  if (!app.isPackaged && !process.env.FINECRM_UPDATE_DEV) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return; // сборка без модуля обновлений — работаем как раньше
  }

  const box = (type) => (title, detail, buttons) =>
    dialog
      .showMessageBox(win && !win.isDestroyed() ? win : undefined, {
        type,
        title,
        message: title,
        detail,
        buttons: buttons ?? ["Понятно"],
        defaultId: 0,
        cancelId: buttons ? 1 : 0,
        noLink: true,
      })
      .then((r) => r.response === 0);

  updater = new Updater({
    autoUpdater,
    currentVersion: app.getVersion(),
    ui: {
      ask: box("question"),
      info: box("info"),
      error: box("warning"),
      // Прогресс — на значке в панели задач: видно, даже когда окно свёрнуто.
      progress: (p) => {
        if (win && !win.isDestroyed()) win.setProgressBar(p);
        if (tray) tray.setToolTip(p >= 0 ? `FineCRM — загрузка обновления ${Math.round(p * 100)}%` : "FineCRM");
      },
    },
    installing: showInstalling,
    installFailed: hideInstalling,
    beforeInstall: prepareForUpdate,
    // В журнал рядом с настройками: у собранной программы консоли нет.
    log: (line) => {
      console.log(line);
      try {
        fs.appendFileSync(path.join(app.getPath("userData"), "updater.log"), `${new Date().toISOString()} ${line}\n`);
      } catch {}
    },
  });
  updater.start();
  refreshTray();
}

/**
 * Подготовка к установке обновления: копия базы, затем честная остановка —
 * та же, что при выходе. Установщик после этого застаёт папку программы
 * свободной, а базу — аккуратно закрытой.
 */
async function prepareForUpdate() {
  if (backups) {
    const report = await backups.run("перед обновлением");
    refreshTray();
    if (!report.ok) {
      const answer = await dialog.showMessageBox(win, {
        type: "warning",
        title: "Копия перед обновлением не сделана",
        message: "Не удалось сделать резервную копию базы",
        detail: `${report.error}\n\nОбновление обычно проходит без потерь, но без свежей копии откатиться будет не к чему. Лучше сначала разобраться с копией.`,
        buttons: ["Отложить обновление", "Обновить без копии"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { ok: false, error: "Обновление отложено: нет свежей резервной копии." };
    }
  }

  // Дальше программа закрывается: помечаем выход, чтобы обработчик
  // before-quit не начал ту же остановку второй раз.
  app.isQuitting = true;
  shuttingDown = true;
  try {
    if (backups) backups.stop();
    if (updater) updater.stop();
    if (responder) responder.close();
    if (backend) await backend.stop();
    if (postgres) await postgres.stop();
  } catch (err) {
    // Не остановилось — не ставим: установщик застал бы базу работающей.
    // Часть служб уже погашена, поэтому просто перезапускаемся на прежней
    // версии: так программа гарантированно вернётся в рабочее состояние.
    await dialog.showMessageBox(win, {
      type: "error",
      title: "Обновление отложено",
      message: "Не удалось остановить сервер перед обновлением",
      detail: `${err.message}\n\nПрограмма перезапустится на прежней версии.`,
    });
    app.relaunch();
    app.exit(0);
    return { ok: false, error: err.message };
  }

  return { ok: true };
}

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
      if (responder) responder.close();
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
