"use strict";

const path = require("path");
const fs = require("fs");

/**
 * Раскладка папки данных.
 *
 * Всё, что мастерская наживает, лежит в одной папке — её выбирает человек при
 * первом запуске, её же он копирует на флешку. Ничего важного не остаётся ни
 * в папке программы, ни в реестре: программу можно снести и поставить заново,
 * данные это не заденет.
 *
 *   <папка данных>/
 *     db/        кластер PostgreSQL
 *     files/     фотографии заказов
 *     backups/   резервные копии
 *     logs/      журналы базы и бэкенда
 *     config.json
 */
function layout(dataDir) {
  const root = path.resolve(dataDir);
  return {
    root,
    db: path.join(root, "db"),
    files: path.join(root, "files"),
    backups: path.join(root, "backups"),
    logs: path.join(root, "logs"),
    config: path.join(root, "config.json"),
  };
}

/** Создаёт недостающие папки. Существующие не трогает. */
function ensureLayout(dataDir) {
  const l = layout(dataDir);
  for (const dir of [l.root, l.files, l.backups, l.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return l;
}

// ------------------------------------------------- где лежит то, что едет с нами

/** Папка программы: desktop/ в репозитории. */
const appDir = () => path.join(__dirname, "..");
/** Корень репозитория — на один уровень выше. */
const repoDir = () => path.join(appDir(), "..");

/**
 * Где искать ресурс — бинарники базы, собранный сервер, собранный интерфейс.
 *
 * Хитрость в том, что `process.resourcesPath` существует ВСЕГДА, когда работает
 * Electron: при запуске командой `electron .` он указывает внутрь самого
 * Electron, в его собственные ресурсы. Проверять его на наличие бесполезно —
 * программа честно шла искать initdb.exe в гости к Electron и не находила.
 *
 * Поэтому смотрим не «собраны мы или нет», а что реально лежит на диске:
 * сначала папку разработки, потом ресурсы собранной программы. Первая
 * существующая и выигрывает.
 */
function findDir(candidates, missing, hint) {
  for (const dir of candidates) {
    if (dir && fs.existsSync(dir)) return dir;
  }
  throw new Error(`${missing} ${hint}`);
}

/**
 * Бинарники PostgreSQL.
 *
 * На Linux при проверках сюда подставляется системный постгрес переменной
 * окружения — так механизм проверяется, не собирая установщик под Windows.
 */
function postgresBinDir() {
  if (process.env.FINECRM_PG_BIN) return process.env.FINECRM_PG_BIN;
  return findDir(
    [
      path.join(appDir(), "vendor", "pgsql", "bin"),
      process.resourcesPath && path.join(process.resourcesPath, "pgsql", "bin"),
    ],
    "Бинарники PostgreSQL не найдены.",
    "Распакуйте архив с сайта EnterpriseDB в desktop\\vendor — нужна папка desktop\\vendor\\pgsql\\bin."
  );
}

/**
 * Собранный сервер.
 *
 * Проверяем не папку, а сам dist/index.js: папка backend существует и в
 * репозитории, где сервер ещё не собран, и «нашли» её было бы обманом —
 * ошибка всплыла бы на шаг позже и непонятнее.
 */
function backendDir() {
  if (process.env.FINECRM_BACKEND) return process.env.FINECRM_BACKEND;

  const roots = [
    process.resourcesPath && path.join(process.resourcesPath, "backend"),
    path.join(repoDir(), "backend"),
  ];
  return findDir(
    roots.map((r) => (r && fs.existsSync(path.join(r, "dist", "index.js")) ? r : null)),
    "Собранный сервер не найден.",
    "Соберите его: cd backend, npm install, npm run build."
  );
}

/** Собранный интерфейс: папка с index.html. */
function frontendDir() {
  if (process.env.FINECRM_FRONTEND) return process.env.FINECRM_FRONTEND;
  return findDir(
    [
      process.resourcesPath && path.join(process.resourcesPath, "frontend"),
      path.join(repoDir(), "frontend", "dist"),
    ],
    "Собранный интерфейс не найден.",
    "Соберите его: cd frontend, npm install, npm run build."
  );
}

/** Имя исполняемого файла с учётом системы. */
const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);

module.exports = { layout, ensureLayout, postgresBinDir, backendDir, frontendDir, exe };
