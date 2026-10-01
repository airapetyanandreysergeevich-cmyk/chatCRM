"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Печать через CRM — сторона программы.
 *
 * Программа становится «станцией печати»: страница CRM в окне программы
 * сообщает серверу, какие принтеры видит Windows этого компьютера, и
 * забирает задания (см. frontend/src/lib/printStation.ts). Само задание
 * печатается здесь: бланк открывается в невидимом окне и уходит на принтер
 * без системного окна печати.
 *
 * Странице отдаём только три действия и только главному окну программы.
 * Печатать можно лишь бланки самой CRM — адрес проверяется, чужую страницу
 * через этот мостик на принтер не отправить.
 */

const READY = "FINECRM-PRINT-READY";
const FAILED = "FINECRM-PRINT-ERROR:";
const LOAD_TIMEOUT_MS = 45_000;

/** Постоянный номер программы на этом компьютере: по нему сервер узнаёт станцию. */
function deviceId(userDataDir) {
  const file = path.join(userDataDir, "print-station.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved && typeof saved.id === "string" && saved.id.length >= 8) return saved.id;
  } catch {
    // первый запуск — заведём
  }
  const id = crypto.randomUUID();
  try {
    fs.writeFileSync(file, JSON.stringify({ id }));
  } catch {
    // не записали — номер поменяется при следующем запуске, станция заведётся заново
  }
  return id;
}

/**
 * Можно ли печатать этот адрес: та же CRM, что открыта в окне, и только
 * страница бланка или тестовой страницы в режиме станции.
 */
function allowedPrintUrl(raw, pageUrl) {
  let url;
  let page;
  try {
    url = new URL(raw);
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (url.origin !== page.origin) return false;
  if (url.searchParams.get("station") !== "1") return false;
  return /^(\/b\/[A-Za-z0-9_-]{4,64})?\/(orders\/[0-9a-f-]{36}\/print|print-test)$/.test(url.pathname);
}

/** Причина отказа Chromium — человеческими словами. */
function failureText(reason) {
  const r = String(reason || "").toLowerCase();
  if (r.includes("invalid printer") || r.includes("invalid deviceName".toLowerCase())) {
    return "Windows не нашла этот принтер — он удалён или переименован";
  }
  if (r.includes("cancel")) return "Печать отменена";
  return `Принтер не принял задание${reason ? ` (${reason})` : ""}`;
}

function register({ ipcMain, BrowserWindow, getWindow, userDataDir }) {
  const id = deviceId(userDataDir);
  const fromMain = (e) => {
    const w = getWindow();
    return !!w && !w.isDestroyed() && e.sender === w.webContents;
  };

  ipcMain.handle("desktop:print-info", (e) =>
    fromMain(e) ? { ok: true, deviceId: id, name: os.hostname() } : { ok: false }
  );

  ipcMain.handle("desktop:printers", async (e) => {
    if (!fromMain(e)) return { ok: false };
    const list = await getWindow().webContents.getPrintersAsync();
    return {
      ok: true,
      printers: list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault })),
    };
  });

  ipcMain.handle("desktop:print", async (e, job) => {
    if (!fromMain(e)) return { ok: false, error: "Печать — только из окна программы" };
    const { url, printer, copies } = job || {};
    if (!allowedPrintUrl(url, e.senderFrame.url)) return { ok: false, error: "Этот адрес печатать нельзя" };
    if (typeof printer !== "string" || !printer) return { ok: false, error: "Не указан принтер" };

    const known = await getWindow().webContents.getPrintersAsync();
    if (!known.some((p) => p.name === printer)) {
      return { ok: false, error: `Windows этого компьютера не видит принтер «${printer}»` };
    }

    // Невидимое окно в той же сессии: бланк загружает заказ с тем же входом,
    // что и окно программы.
    const sheet = new BrowserWindow({
      show: false,
      width: 900,
      height: 1270,
      webPreferences: {
        session: getWindow().webContents.session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Скрытое окно иначе притормаживают, и бланк может не дорисоваться.
        backgroundThrottling: false,
      },
    });
    try {
      const ready = new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: "Бланк не загрузился за 45 секунд" }), LOAD_TIMEOUT_MS);
        sheet.webContents.on("page-title-updated", (_ev, title) => {
          if (title === READY) {
            clearTimeout(timer);
            resolve({ ok: true });
          } else if (title.startsWith(FAILED)) {
            clearTimeout(timer);
            resolve({ ok: false, error: title.slice(FAILED.length) || "Бланк не открылся" });
          }
        });
        sheet.webContents.on("did-fail-load", (_ev, _code, desc) => {
          clearTimeout(timer);
          resolve({ ok: false, error: `Бланк не открылся: ${desc}` });
        });
      });
      await sheet.loadURL(url);
      const loaded = await ready;
      if (!loaded.ok) return loaded;

      return await new Promise((resolve) => {
        sheet.webContents.print(
          {
            silent: true,
            deviceName: printer,
            copies: Math.min(2, Math.max(1, Number(copies) || 1)),
            printBackground: true,
            pageSize: "A4",
          },
          (success, reason) => resolve(success ? { ok: true } : { ok: false, error: failureText(reason) })
        );
      });
    } catch (err) {
      return { ok: false, error: `Не удалось напечатать: ${err && err.message ? err.message : err}` };
    } finally {
      if (!sheet.isDestroyed()) sheet.destroy();
    }
  });
}

module.exports = { register, allowedPrintUrl, deviceId, failureText, READY, FAILED };
