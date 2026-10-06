"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Папка заказа — сторона программы.
 *
 * Страница CRM просит: «открой папку заказа Р-3934, назови её Р-3934_Ноутбук
 * Asus X550». Здесь она создаётся внутри общей папки заказов этого компьютера
 * и открывается в Проводнике (Finder на Mac).
 *
 * Общую папку выбирает человек на этом компьютере — у Основы это D:\Заказы,
 * у сотрудника та же папка по сети. Путь хранится здесь, в order-folders.json
 * рядом с остальными настройками программы, и на сервер не уходит.
 *
 * Странице отдаём три действия и только главному окну. Имя папки странице
 * не доверяем: каждая часть чистится от запрещённых символов, и создать
 * что-то за пределами общей папки нельзя.
 */

const STORE = "order-folders.json";

function readRoot(userDataDir) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, STORE), "utf8"));
    return typeof saved.root === "string" && saved.root ? saved.root : null;
  } catch {
    return null;
  }
}

function writeRoot(userDataDir, root) {
  fs.writeFileSync(path.join(userDataDir, STORE), JSON.stringify({ root }, null, 2));
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Часть имени, безопасная для Windows и Mac: без \ / : * ? " < > |, без
 * управляющих символов, без точек и пробелов на конце, не «CON» и не «..».
 */
function safePart(raw, max = 60) {
  let s = String(raw == null ? "" : raw)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, "");
  if (RESERVED.test(s)) s = "_" + s;
  return s;
}

/** «Р-3934» + ["Ноутбук Asus X550", "Иванов"] → «Р-3934_Ноутбук Asus X550_Иванов». */
function folderName(number, parts) {
  const num = safePart(number, 40);
  if (!num) return null;
  const rest = (Array.isArray(parts) ? parts : []).map((p) => safePart(p, 60)).filter(Boolean);
  return [num, ...rest].join("_").slice(0, 150).replace(/[. ]+$/, "");
}

/**
 * Уже заведённая папка заказа: имя — номер или номер и «_»/пробел дальше.
 * Технику в заказе поправили — откроется прежняя папка, вторая не появится.
 * «3934» не находит «39345_…».
 */
function findExisting(dir, number) {
  const key = safePart(number, 40).toLowerCase();
  if (!key) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const hit = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => {
      const l = n.toLowerCase();
      return l === key || l.startsWith(key + "_") || l.startsWith(key + " ");
    })
    .sort((a, b) => a.length - b.length)[0];
  return hit ? path.join(dir, hit) : null;
}

const inside = (root, p) => {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * Найти или завести папку заказа.
 * req: { number, parts, year, byYear } — от страницы, ничему здесь не верим на слово.
 */
function resolveFolder(root, req, { create = true } = {}) {
  if (!root) return { ok: false, needRoot: true, error: "На этом компьютере не выбрана общая папка заказов" };
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    return { ok: false, missingRoot: true, error: `Не найдена папка заказов «${root}». Диск не подключён или папку переименовали?` };
  }
  if (!st.isDirectory()) return { ok: false, missingRoot: true, error: `«${root}» — не папка` };

  const name = folderName(req && req.number, req && req.parts);
  if (!name) return { ok: false, error: "У заказа нет номера" };
  const year = Number(req && req.year);
  const yearDir = req && req.byYear && year >= 2000 && year <= 2100 ? path.join(root, String(year)) : root;

  const found = findExisting(yearDir, req.number) || (yearDir !== root ? findExisting(root, req.number) : null);
  if (found) return { ok: true, path: found, created: false };
  if (!create) return { ok: true, path: null, created: false };

  const target = path.join(yearDir, name);
  if (!inside(root, target)) return { ok: false, error: "Недопустимое имя папки" };
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    const code = err && err.code;
    const why =
      code === "EACCES" || code === "EPERM"
        ? "нет прав на запись"
        : code === "ENOSPC"
          ? "нет места на диске"
          : code === "EROFS"
            ? "папка только для чтения"
            : (err && err.message) || "неизвестная ошибка";
    return { ok: false, error: `Не удалось создать папку заказа: ${why}` };
  }
  return { ok: true, path: target, created: true };
}

function register({ ipcMain, dialog, shell, getWindow, userDataDir }) {
  const fromMain = (e) => {
    const w = getWindow();
    return !!w && !w.isDestroyed() && e.sender === w.webContents;
  };

  ipcMain.handle("desktop:order-folder-info", (e) => (fromMain(e) ? { ok: true, root: readRoot(userDataDir) } : { ok: false }));

  ipcMain.handle("desktop:order-folder-pick", async (e) => {
    if (!fromMain(e)) return { ok: false };
    const cur = readRoot(userDataDir);
    const res = await dialog.showOpenDialog(getWindow(), {
      title: "Общая папка заказов на этом компьютере",
      defaultPath: cur || undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true, root: cur };
    try {
      writeRoot(userDataDir, res.filePaths[0]);
    } catch (err) {
      return { ok: false, error: `Не удалось запомнить папку: ${err.message}` };
    }
    return { ok: true, root: res.filePaths[0] };
  });

  ipcMain.handle("desktop:order-folder-forget", (e) => {
    if (!fromMain(e)) return { ok: false };
    try {
      fs.rmSync(path.join(userDataDir, STORE), { force: true });
    } catch {
      // нечего забывать
    }
    return { ok: true, root: null };
  });

  // Создать (если нет) и открыть в Проводнике.
  ipcMain.handle("desktop:order-folder-open", async (e, req) => {
    if (!fromMain(e)) return { ok: false };
    const r = resolveFolder(readRoot(userDataDir), req);
    if (!r.ok) return r;
    const err = await shell.openPath(r.path);
    return err ? { ok: false, path: r.path, error: `Папка есть, но не открылась: ${err}` } : r;
  });

  // Только создать — при приёме заказа, окно Проводника не нужно.
  ipcMain.handle("desktop:order-folder-ensure", (e, req) => {
    if (!fromMain(e)) return { ok: false };
    return resolveFolder(readRoot(userDataDir), req);
  });
}

module.exports = { register, resolveFolder, folderName, safePart, findExisting, readRoot, writeRoot };
