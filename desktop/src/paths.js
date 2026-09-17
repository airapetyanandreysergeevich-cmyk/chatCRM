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

/**
 * Где лежат бинарники PostgreSQL.
 *
 * В собранной программе они едут рядом, в resources. В разработке путь
 * задаётся переменной окружения — на Linux это системный постгрес, и так
 * механизм проверяется, не собирая установщик под Windows.
 */
function postgresBinDir() {
  if (process.env.FINECRM_PG_BIN) return process.env.FINECRM_PG_BIN;
  const base = process.resourcesPath || path.join(__dirname, "..");
  return path.join(base, "pgsql", "bin");
}

/** Имя исполняемого файла с учётом системы. */
const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);

module.exports = { layout, ensureLayout, postgresBinDir, exe };
