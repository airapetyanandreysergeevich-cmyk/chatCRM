"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { ensureLayout, backendDir } = require("./paths");
const config = require("./config");
const { LocalPostgres, freePort } = require("./postgres");

/**
 * Подготовка Основы к работе.
 *
 * Один проход, который можно повторять сколько угодно раз: всё, что уже
 * сделано, пропускается. Это важнее, чем кажется, — программу будут закрывать
 * кнопкой питания и запускать заново, и каждый запуск обязан приводить
 * установку в рабочее состояние, а не требовать «переустановить».
 */

/** Последние строки журнала — по ним видно, на чём именно встало. */
function tail(file, lines = 8) {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-lines).join(" | ");
  } catch {
    return "";
  }
}

/**
 * Запускает вспомогательный инструмент на Node и ждёт его.
 *
 * Три решения, и каждое — из-за Windows:
 *
 * 1. Запускаем сам файл инструмента, а не обёртку .cmd из node_modules\.bin.
 *    Обёртка поднимает cmd.exe, тот держит потоки вывода открытыми, и
 *    ожидание не заканчивается никогда — программа виснет на ровном месте,
 *    хотя работа давно сделана.
 * 2. Вывод отправляем сразу в файл, а не перехватываем: по той же причине, и
 *    заодно в мастерской остаётся журнал, который можно прислать.
 * 3. Ставим срок. Инструмент, замерший навсегда, — худшее, что может
 *    случиться на первом запуске: человек видит крутилку и не знает, ждать
 *    ему минуту или до завтра.
 */
function runTool(script, args, { cwd, env, logFile, what, input, timeoutMs = 5 * 60_000 }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, "a");
    fs.writeSync(out, `\n=== ${new Date().toISOString()} ${what} ===\n`);

    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      // ELECTRON_RUN_AS_NODE: в собранной программе отдельного node нет, его
      // роль играет сам Electron.
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
      // Пароль передаём через стандартный ввод, а не аргументом: аргументы
      // видны в списке процессов любому, кто откроет диспетчер задач.
      stdio: [input === undefined ? "ignore" : "pipe", out, out],
      windowsHide: true,
    });

    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }

    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        fs.closeSync(out);
      } catch {
        /* уже закрыт */
      }
      fn(arg);
    };

    const timer = setTimeout(() => {
      child.kill();
      const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} мин` : `${Math.round(timeoutMs / 1000)} с`;
      finish(reject, new Error(`${what}: не уложилось в ${limit}. ${tail(logFile)}`));
    }, timeoutMs);

    child.once("error", (err) => finish(reject, new Error(`${what}: ${err.message}`)));
    child.once("exit", (code) => {
      if (code === 0) return finish(resolve);
      finish(reject, new Error(`${what}: код ${code}. ${tail(logFile)}`));
    });
  });
}

/** Командная строка Prisma — обычный файл на Node, запускаем его напрямую. */
function prismaCli(backend) {
  return path.join(backend, "node_modules", "prisma", "build", "index.js");
}

/**
 * @param {string} dataDir папка данных мастерской
 * @param {(step: string) => void} [say] куда сообщать о ходе — на первом
 *        запуске это единственное, что человек видит минуту-другую
 * @param {{workshop, fullName, email, password}|null} [owner] данные первого
 *        входа; передаются только на первом запуске, дальше мастерская уже есть
 */
async function prepareMain(dataDir, say = () => {}, owner = null) {
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
    await runTool(prismaCli(be), ["migrate", "deploy"], {
      cwd: be,
      env: { DATABASE_URL: config.databaseUrl(cfg, "owner") },
      logFile: path.join(l.logs, "prisma.log"),
      what: "Обновление структуры базы",
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

    if (owner) {
      say("Завожу мастерскую");
      await runTool(
        path.join(be, "dist", "cli", "create-workshop.js"),
        // --demo — галочка «Заполнить базу тестовыми данными» на первом экране.
        [owner.workshop, owner.fullName, owner.email, ...(owner.demo === true ? ["--demo"] : [])],
        {
          cwd: be,
          env: { DATABASE_URL: config.databaseUrl(cfg, "owner") },
          logFile: path.join(l.logs, "prisma.log"),
          what: "Создание мастерской",
          input: owner.password,
          timeoutMs: 60_000,
        }
      );
      cfg.workshopName = owner.workshop;
      config.write(l.config, cfg);
    }

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
    // Без них сервер не стартует вовсе — и правильно делает: это ключи,
    // которыми подписан вход сотрудников.
    JWT_ACCESS_SECRET: cfg.auth.accessSecret,
    JWT_REFRESH_SECRET: cfg.auth.refreshSecret,
    PORT: String(cfg.share.port),
    // В локальном режиме слушаем только себя, пока раздача не включена явно.
    BIND_HOST: cfg.share.enabled ? "0.0.0.0" : "127.0.0.1",
    // Внутри мастерской ходим по обычному HTTP, без сертификата. С пометкой
    // «только по HTTPS» браузер не сохранил бы печенье сессии, и сотрудник
    // вылетал бы каждые пятнадцать минут.
    COOKIE_SECURE: "false",
    // Файлы вместо S3.
    STORAGE_DRIVER: "local",
    STORAGE_DIR: l.files,
    CORS_ORIGIN: "*",
  };
}

module.exports = { prepareMain, backendEnv, runTool };
