"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const { ensureLayout } = require("./paths");
const config = require("./config");
const { LocalPostgres, freePort } = require("./postgres");

const run = promisify(execFile);

/**
 * Подготовка Основы к работе.
 *
 * Один проход, который можно повторять сколько угодно раз: всё, что уже
 * сделано, пропускается. Это важнее, чем кажется, — программу будут закрывать
 * кнопкой питания и запускать заново, и каждый запуск обязан приводить
 * установку в рабочее состояние, а не требовать «переустановить».
 */

/** Где лежит бэкенд: рядом с программой или, в разработке, в репозитории. */
function backendDir() {
  if (process.env.FINECRM_BACKEND) return process.env.FINECRM_BACKEND;
  const base = process.resourcesPath || path.join(__dirname, "..");
  return path.join(base, "backend");
}

async function prisma(args, { cwd, env, log }) {
  const bin = path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");
  const { stdout, stderr } = await run(bin, args, { cwd, env: { ...process.env, ...env } });
  if (log) log(stdout || stderr);
  return stdout;
}

/**
 * @param {string} dataDir папка данных мастерской
 * @param {(step: string) => void} [say] куда сообщать о ходе — на первом
 *        запуске это единственное, что человек видит минуту-другую
 */
async function prepareMain(dataDir, say = () => {}) {
  const l = ensureLayout(dataDir);

  say("Читаю настройки");
  const cfg = config.ensureSecrets(config.read(l.config));
  cfg.mode = config.MODE.MAIN;

  const pg = new LocalPostgres({ dataDir: l.db, logDir: l.logs });

  if (!pg.initialized) {
    say("Создаю базу данных — это делается один раз и занимает до минуты");
    await pg.initdb(cfg.db.ownerPassword);
    // Суперпользователь postgres нужен только на время настройки; пароль ему
    // ставим тот же, что владельцу схемы, чтобы не плодить третий секрет.
  }

  if (!cfg.db.port) cfg.db.port = await freePort();
  config.write(l.config, cfg);

  say("Запускаю базу");
  await pg.start(cfg.db.port);

  try {
    say("Проверяю роли и права");
    await pg.provision(cfg.db, cfg.db.ownerPassword);

    const be = backendDir();
    say("Обновляю структуру базы");
    await prisma(["migrate", "deploy"], {
      cwd: be,
      env: { DATABASE_URL: config.databaseUrl(cfg, "owner") },
    });

    // Построчную защиту миграции не ставят — она живёт отдельным файлом и
    // переприменяется при каждом запуске. Файл идемпотентный.
    say("Применяю правила изоляции");
    // Под владельцем схемы: ALTER TABLE требует владения, а суперпользователь
    // здесь только развёл роли и дальше не участвует.
    await pg.psqlFile(path.join(be, "prisma", "rls.sql"), {
      database: cfg.db.name,
      user: cfg.db.ownerUser,
      password: cfg.db.ownerPassword,
    });

    return { config: cfg, layout: l, postgres: pg };
  } catch (err) {
    await pg.stop().catch(() => {});
    throw err;
  }
}

/** Окружение для бэкенда в локальном режиме. */
function backendEnv(cfg, l) {
  return {
    NODE_ENV: "production",
    DATABASE_URL: config.databaseUrl(cfg, "app"),
    MIGRATE_DATABASE_URL: config.databaseUrl(cfg, "owner"),
    PORT: String(cfg.share.port),
    // В локальном режиме слушаем только себя, пока раздача не включена явно.
    BIND_HOST: cfg.share.enabled ? "0.0.0.0" : "127.0.0.1",
    // Файлы вместо S3.
    STORAGE_DRIVER: "local",
    STORAGE_DIR: l.files,
    CORS_ORIGIN: "*",
  };
}

module.exports = { prepareMain, backendEnv, backendDir };
