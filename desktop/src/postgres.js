"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const { postgresBinDir, exe } = require("./paths");

const run = promisify(execFile);

/**
 * Встроенный PostgreSQL.
 *
 * Берём настоящий постгрес, а не файловую базу, по одной причине: та же
 * схема, те же миграции и та же построчная защита, что в облаке. Как только
 * локальная база начнёт синхронизироваться с облачной, любое расхождение
 * между ними станет источником ошибок, которые не воспроизвести.
 *
 * Кластер живёт в папке данных мастерской и слушает только 127.0.0.1 —
 * наружу базу не выставляем никогда. Сотрудники с других компьютеров ходят
 * в HTTP-API, где работают права; прямой доступ к базе означал бы, что от
 * разграничения доступа не осталось ничего.
 */

const HOST = "127.0.0.1";

/** Свободный порт спрашиваем у системы: занятые 5432 в мастерских не редкость. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

class LocalPostgres {
  /**
   * @param {object} o
   * @param {string} o.dataDir папка кластера (…/db)
   * @param {string} o.logDir  куда писать журнал базы
   * @param {string} [o.binDir] папка с бинарниками; по умолчанию — рядом с программой
   */
  constructor({ dataDir, logDir, binDir }) {
    this.dataDir = path.resolve(dataDir);
    this.logDir = path.resolve(logDir);
    this.binDir = binDir || postgresBinDir();
  }

  bin(name) {
    return path.join(this.binDir, exe(name));
  }

  /** Кластер уже создан? */
  get initialized() {
    return fs.existsSync(path.join(this.dataDir, "PG_VERSION"));
  }

  /**
   * Создаёт кластер.
   *
   * Сортировку задаём через ICU: в мастерской список клиентов сортируется по
   * фамилиям, и порядок букв должен быть русским. Системные локали на Windows
   * и Linux называются по-разному, а ICU одинаков везде — иначе одна и та же
   * база сортировала бы по-разному на разных компьютерах.
   */
  async initdb(superPassword) {
    if (this.initialized) return false;

    fs.mkdirSync(path.dirname(this.dataDir), { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });

    const pwFile = path.join(os.tmpdir(), `finecrm-init-${process.pid}`);
    fs.writeFileSync(pwFile, superPassword, { encoding: "utf8", mode: 0o600 });
    try {
      await run(this.bin("initdb"), [
        "--pgdata", this.dataDir,
        "--username", "postgres",
        "--auth-local=scram-sha-256",
        "--auth-host=scram-sha-256",
        "--pwfile", pwFile,
        "--encoding=UTF8",
        "--locale-provider=icu",
        "--icu-locale=ru-RU",
        // ICU не задаёт LC_CTYPE, а без него initdb ругается на некоторых системах.
        "--locale=C",
      ]);
    } finally {
      fs.rmSync(pwFile, { force: true });
    }
    return true;
  }

  /**
   * Дописывает настройки кластера.
   *
   * Отдельным файлом, а не правкой postgresql.conf: свой файл можно
   * переписывать при каждом запуске, не боясь затереть то, что постгрес
   * пишет в основной конфиг сам.
   */
  writeConf(port) {
    const conf = [
      "# Файл создаётся программой при каждом запуске. Править руками бесполезно.",
      `listen_addresses = '${HOST}'`,
      `port = ${port}`,
      // Файловых сокетов не держим вовсе: по умолчанию постгрес кладёт их в
      // системную папку, куда у обычного пользователя нет прав, и старт
      // падает. Подключаются к нам только по 127.0.0.1.
      "unix_socket_directories = ''",
      "max_connections = 30",
      "shared_buffers = 128MB",
      "work_mem = 8MB",
      "logging_collector = on",
      `log_directory = '${this.logDir.replace(/\\/g, "/")}'`,
      "log_filename = 'postgres-%Y-%m-%d.log'",
      "log_rotation_age = 1d",
      "log_min_duration_statement = 2000",
      // Мастерская выключает компьютер кнопкой. Честная запись на диск —
      // единственное, что отделяет это от повреждённой базы.
      "fsync = on",
      "synchronous_commit = on",
      "",
    ].join("\n");

    fs.writeFileSync(path.join(this.dataDir, "finecrm.conf"), conf, "utf8");

    const main = path.join(this.dataDir, "postgresql.conf");
    const include = "include_if_exists = 'finecrm.conf'";
    const body = fs.readFileSync(main, "utf8");
    if (!body.includes(include)) fs.appendFileSync(main, `\n${include}\n`);
  }

  /** Запуск. pg_ctl, а не postgres напрямую: на Windows он сам понижает права. */
  async start(port) {
    this.writeConf(port);
    await run(this.bin("pg_ctl"), [
      "start",
      "--pgdata", this.dataDir,
      "--wait",
      "--timeout", "60",
      "--log", path.join(this.logDir, "pg_ctl.log"),
    ]);
    this.port = port;
  }

  async stop() {
    try {
      await run(this.bin("pg_ctl"), [
        "stop",
        "--pgdata", this.dataDir,
        "--wait",
        "--timeout", "60",
        // fast: оборвать открытые соединения, но корректно закрыть файлы.
        // smart ждал бы, пока последний сотрудник закроет окно, — программа
        // при этом висела бы в трее и не выключалась.
        "--mode", "fast",
      ]);
    } catch (err) {
      // Уже остановлен — не повод падать при выходе из программы.
      if (!String(err.stdout ?? "").includes("not running")) throw err;
    }
  }

  async isRunning() {
    try {
      await run(this.bin("pg_isready"), ["-h", HOST, "-p", String(this.port), "-t", "3"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Выполняет SQL.
   *
   * По умолчанию — под суперпользователем, но роль выбирается: правила
   * изоляции обязан ставить владелец таблиц, а не кто угодно с паролем.
   */
  async psql(sql, { database = "postgres", user = "postgres", password } = {}) {
    const { stdout } = await run(
      this.bin("psql"),
      // -t -A: только значения, без шапки и рамки. Иначе любая проверка
      // «пусто ли в ответе» всегда видит строку заголовка и врёт.
      ["-h", HOST, "-p", String(this.port), "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-c", sql],
      { env: { ...process.env, PGPASSWORD: password } }
    );
    return stdout;
  }

  async psqlFile(file, { database, user = "postgres", password }) {
    const { stdout } = await run(
      this.bin("psql"),
      ["-h", HOST, "-p", String(this.port), "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-f", file],
      { env: { ...process.env, PGPASSWORD: password } }
    );
    return stdout;
  }

  /**
   * Создаёт базу и две роли.
   *
   * Владелец схемы накатывает миграции, приложение ходит под отдельной ролью
   * без права обходить построчную защиту. Это ровно та же расстановка, что на
   * сервере: суперпользователь игнорирует RLS всегда, и приложение под ним
   * означало бы, что изоляции нет.
   */
  async provision(db, superPassword) {
    const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
    const opts = { password: superPassword };

    const exists = async (sql) => (await this.psql(sql, opts)).trim() !== "";

    if (!(await exists(`SELECT 1 FROM pg_roles WHERE rolname = ${q(db.ownerUser)}`))) {
      await this.psql(`CREATE ROLE ${db.ownerUser} LOGIN PASSWORD ${q(db.ownerPassword)} CREATEDB NOBYPASSRLS`, opts);
    }
    if (!(await exists(`SELECT 1 FROM pg_roles WHERE rolname = ${q(db.appUser)}`))) {
      await this.psql(`CREATE ROLE ${db.appUser} LOGIN PASSWORD ${q(db.appPassword)} NOBYPASSRLS`, opts);
    }
    if (!(await exists(`SELECT 1 FROM pg_database WHERE datname = ${q(db.name)}`))) {
      await this.psql(`CREATE DATABASE ${db.name} OWNER ${db.ownerUser}`, opts);
    }

    const inDb = { database: db.name, password: superPassword };
    await this.psql(`GRANT CONNECT ON DATABASE ${db.name} TO ${db.appUser}`, inDb);
    await this.psql(`GRANT USAGE ON SCHEMA public TO ${db.appUser}`, inDb);
    await this.psql(`ALTER SCHEMA public OWNER TO ${db.ownerUser}`, inDb);
    // Таблицы создаст миграция — права раздаём «на будущее», от имени
    // владельца, иначе они не достанутся тому, что он создаст потом.
    await this.psql(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${db.ownerUser} IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${db.appUser}`,
      inDb
    );
    await this.psql(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${db.ownerUser} IN SCHEMA public ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${db.appUser}`,
      inDb
    );
    // Если база уже была — раздаём и на существующее.
    await this.psql(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${db.appUser}`,
      inDb
    );
    await this.psql(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${db.appUser}`, inDb);
  }
}

module.exports = { LocalPostgres, freePort, HOST };
