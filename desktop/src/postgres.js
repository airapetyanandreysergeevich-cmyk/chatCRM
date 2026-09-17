"use strict";

const { execFile, spawn } = require("child_process");
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

/**
 * Читает текст, написанный программой в консольной кодировке.
 *
 * Русская Windows переводит сообщения программ на русский и пишет их не в
 * UTF-8, а в кодировке консоли. Прочитанные как UTF-8, они превращаются в
 * «??????» — и объяснение отказа, ради которого всё и затевалось, становится
 * нечитаемым ровно там, где оно нужнее всего. Поэтому если UTF-8 не сложился,
 * пробуем кодировки, в которых Windows и говорит по-русски.
 */
function readText(file) {
  const buf = fs.readFileSync(file);
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("�")) return utf8;

  // Обе русские однобайтовые кодировки расписывают все 256 байт, поэтому
  // «прочиталось без порчи» их не различает: CP1251, прочитанная как CP866,
  // даёт бодрое «ю°шсър» и ни одного знака вопроса. Различает только смысл —
  // какой вариант больше похож на русский текст, а не на псевдографику.
  // А какая из двух придёт, заранее не известно: в консоль Windows пишет в
  // одной, в перенаправленный в файл поток — в другой.
  let best = utf8;
  let bestScore = -Infinity;
  for (const encoding of ["windows-1251", "ibm866"]) {
    try {
      const guess = new TextDecoder(encoding).decode(buf);
      const score = russianness(guess);
      if (score > bestScore) {
        best = guess;
        bestScore = score;
      }
    } catch {
      /* такой кодировки в этой сборке нет — пробуем следующую */
    }
  }
  return best;
}

/** Насколько текст похож на русский, а не на мусор от чужой кодировки. */
function russianness(text) {
  let letters = 0;
  let junk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x0410 && c <= 0x044f) || c === 0x0401 || c === 0x0451) letters++;
    // Псевдографика и латиница с диакритикой в сообщениях постгреса не
    // встречаются — зато ими полон текст, прочитанный не в той кодировке.
    else if ((c >= 0x2500 && c <= 0x25ff) || (c >= 0x00a0 && c <= 0x00ff)) junk++;
  }
  return letters - junk * 2;
}

/**
 * Коды, которыми Windows отвечает вместо объяснения.
 *
 * Когда программа не смогла даже начаться, она ничего не пишет — ни в журнал,
 * ни куда-либо ещё; наружу выходит только число. `3221225781` выглядит как
 * мусор, а означает вполне конкретное: на компьютере нет библиотеки, без
 * которой `initdb.exe` не запускается. На машине разработчика она есть всегда
 * (её ставят студии и десяток других программ), на чистой — почти никогда.
 * Поэтому это и выглядит как «у тебя работает, у меня нет».
 */
const WINDOWS_CODES = {
  3221225781: // 0xC0000135 STATUS_DLL_NOT_FOUND
    "на компьютере не хватает системных библиотек Microsoft Visual C++. " +
    "Установите «Microsoft Visual C++ Redistributable (x64)» — он есть на сайте Microsoft.",
  3221225595: // 0xC000007B STATUS_INVALID_IMAGE_FORMAT
    "библиотека оказалась не той разрядности. Нужна 64-разрядная версия Visual C++ Redistributable.",
  3221225794: // 0xC0000142 STATUS_DLL_INIT_FAILED
    "системная библиотека не смогла запуститься. Чаще всего помогает перезагрузка компьютера.",
  3221225477: // 0xC0000005 STATUS_ACCESS_VIOLATION
    "программа аварийно завершилась. Если повторяется — проверьте оперативную память и антивирус.",
};

/**
 * Причина отказа из журнала.
 *
 * Сначала ищем строки, где программа сама назвала ошибку: initdb и постгрес
 * перед падением печатают десяток строк о локалях и часовых поясах, и слепой
 * «хвост файла» показал бы именно их. Если таких строк нет — тогда уже хвост.
 */
function tailFile(file, lines = 6) {
  try {
    const all = readText(file)
      .trimEnd()
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith("==="));
    const said = all.filter((l) => /error|fatal|panic|could not|cannot|ошибк/i.test(l));
    return (said.length ? said : all).slice(-lines).join(" | ");
  } catch {
    return "";
  }
}

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
    this.clearHalfCluster();

    const pwFile = path.join(os.tmpdir(), `finecrm-init-${process.pid}`);
    fs.writeFileSync(pwFile, superPassword, { encoding: "utf8", mode: 0o600 });
    try {
      await this.runTold("initdb", "Создание кластера", [
        "--pgdata", this.dataDir,
        "--username", "postgres",
        // Файловых сокетов у нас нет ни на одной системе (см. writeConf), но
        // на Windows их нет и в самом постгресе — а раз так, незачем и
        // объяснять ему, как через них пускать. Лишний ключ в командной
        // строке — лишний подозреваемый, когда установка не пошла.
        ...(process.platform === "win32" ? [] : ["--auth-local=scram-sha-256"]),
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
   * Убирает недоделанный кластер, оставшийся от сорвавшейся установки.
   *
   * На чужом компьютере первая попытка оборвалась, и в папке `db` осталась
   * горстка файлов. Вторая попытка упёрлась в `directory exists but is not
   * empty` — и человек оказался перед выбором, который сделать не может:
   * стереть папку с базой ему страшно, а без этого программа не идёт дальше.
   *
   * Выбор здесь обманчивый: папка кластера без `PG_VERSION` — не база. Её
   * нельзя запустить ни этой программой, ни чем-либо ещё, и данных в ней нет
   * по определению — сюда ещё ни одна строка не записывалась. Поэтому убираем
   * молча, но прежде переносим в сторону, а не удаляем: `PG_VERSION` может
   * отсутствовать и по причине, которой мы не предвидели.
   */
  clearHalfCluster() {
    if (!fs.existsSync(this.dataDir)) return false;
    if (fs.readdirSync(this.dataDir).length === 0) return false;

    const aside = `${this.dataDir}-неудачный-${Date.now()}`;
    fs.renameSync(this.dataDir, aside);
    return aside;
  }

  /**
   * Запускает программу базы так, чтобы её отказ можно было понять.
   *
   * Здесь уже обжигались: «Command failed: initdb.exe --pgdata …» с длинной
   * командой и без единого слова о причине. Причину initdb печатает — просто
   * её выбрасывали. Теперь весь вывод идёт в журнал рядом с данными, а в
   * сообщение попадают его последние строки: человеку, который видит окно с
   * ошибкой, нужна причина, а не то, что мы запускали.
   *
   * И у ожидания есть срок. Без него «вечное создание базы» — это всё, что
   * человек когда-либо узнает: окно с бегущей полоской, за которым может
   * стоять что угодно, от запроса пароля до антивируса, проверяющего каждый
   * из тысяч создаваемых файлов. Ожидание без срока — это не терпение, а
   * отказ сообщать.
   */
  runTold(name, what, args, { timeoutMs = 5 * 60_000 } = {}) {
    const logFile = path.join(this.logDir, `${name}.log`);
    return new Promise((resolve, reject) => {
      fs.mkdirSync(this.logDir, { recursive: true });
      const out = fs.openSync(logFile, "a");
      fs.writeSync(out, `\n=== ${new Date().toISOString()} ${what} ===\n`);

      const child = spawn(this.bin(name), args, {
        stdio: ["ignore", out, out],
        windowsHide: true,
      });

      let timer = null;
      const finish = (fn, arg) => {
        if (timer) clearTimeout(timer);
        timer = null;
        try {
          fs.closeSync(out);
        } catch {
          /* уже закрыт */
        }
        fn(arg);
      };

      timer = setTimeout(() => {
        child.kill();
        const why = tailFile(logFile);
        finish(
          reject,
          new Error(
            `${what} не уложилось в ${
              timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} мин` : `${Math.round(timeoutMs / 1000)} с`
            } и было прервано.` +
              (why ? ` Последнее, что сказала программа: ${why}` : " Программа не сказала ничего.")
          )
        );
      }, timeoutMs);

      child.once("error", (err) => finish(reject, new Error(`${what}: ${err.message}`)));
      child.once("exit", (code) => {
        if (timer === null) return; // уже прервали по сроку
        if (code === 0) return finish(resolve);
        // Сначала то, что сказала сама программа; если она не успела сказать
        // ничего — переводим код Windows на человеческий.
        const why = tailFile(logFile) || WINDOWS_CODES[code] || "";
        finish(reject, new Error(`${what} не удалось.${why ? ` ${why}` : ` Код ${code}.`}`));
      });
    });
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

  /**
   * Запускает pg_ctl, полностью отвязав его вывод.
   *
   * Здесь была самая дорогая ошибка этого этапа. Обычный запуск с перехватом
   * вывода на Windows **никогда не возвращается**: pg_ctl передаёт свои
   * потоки вывода серверу, сервер уходит работать демоном и держит их
   * открытыми, а Node ждёт не только завершения процесса, но и закрытия
   * потоков. База при этом уже работает и принимает подключения — со стороны
   * выглядит как зависший запуск на ровном месте.
   *
   * Поэтому вывод не перехватываем вовсе: всё, что скажет сервер, и так
   * попадёт в свой журнал, а его мы прочитаем, если что-то пойдёт не так.
   */
  runCtl(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin("pg_ctl"), args, { stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) return resolve();
        const why = this.logTail();
        reject(new Error(`pg_ctl ${args[0]} завершился с кодом ${code}.${why ? ` ${why}` : ""}`));
      });
    });
  }

  /** Последние строки журнала базы — единственное, что объясняет отказ. */
  logTail(lines = 6) {
    try {
      const files = fs
        .readdirSync(this.logDir)
        .filter((f) => f.startsWith("postgres-") && f.endsWith(".log"))
        .sort();
      const last = files[files.length - 1];
      if (!last) return "";
      const text = readText(path.join(this.logDir, last)).trimEnd();
      return text.split(/\r?\n/).slice(-lines).join(" | ");
    } catch {
      return "";
    }
  }

  /**
   * Уже запущен ли наш кластер.
   *
   * Смотрим два признака сразу: файл postmaster.pid в нашей папке данных и
   * живой ответ на нашем порту. По отдельности каждый обманывает — файл
   * остаётся после выключения питания, а на порту может сидеть чужая
   * программа.
   */
  async alreadyRunning() {
    if (!fs.existsSync(path.join(this.dataDir, "postmaster.pid"))) return false;
    return this.isRunning();
  }

  /** Запуск. pg_ctl, а не postgres напрямую: на Windows он сам понижает права. */
  async start(port) {
    this.port = port;

    // Наш же кластер, оставшийся от прошлого запуска, — обычное дело после
    // аварийного закрытия программы. Пытаться поднять его поверх себя же
    // бессмысленно: pg_ctl минуту ждёт, потом отказывает, и человек видит
    // минуту тишины вместо работающей программы.
    if (await this.alreadyRunning()) return;

    this.writeConf(port);

    await this.runCtl([
      "start",
      "--pgdata", this.dataDir,
      "--wait",
      "--timeout", "60",
      "--log", path.join(this.logDir, "pg_ctl.log"),
    ]);

    // pg_ctl с --wait уже дождался готовности, но убедиться дешевле, чем
    // отдать наверх «запущено» и получить отказ на первом же запросе.
    if (!(await this.isRunning())) {
      throw new Error(`База не отвечает на порту ${port}. ${this.logTail()}`.trim());
    }
  }

  async stop() {
    try {
      await this.runCtl([
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
      if (!/код(ом)? 1/.test(err.message)) throw err;
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
   *
   * Запрос уезжает файлом, а не ключом `-c`, и это не придирка к стилю.
   * Командную строку Windows отдаёт программе в кодировке системы, а не в
   * UTF-8: фамилия «Яшин» доезжает до psql как байты CP1251, psql честно
   * объявляет их как UTF-8 — и сервер отвечает `invalid byte sequence for
   * encoding "UTF8"`. Ни одной русской буквы в SQL быть не должно, чтобы это
   * заметить на разработке, — а в мастерской они в каждом запросе. Файл же
   * читается ровно теми байтами, какими записан.
   */
  async psql(sql, opts = {}) {
    const file = path.join(os.tmpdir(), `finecrm-sql-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sql`);
    fs.writeFileSync(file, sql.endsWith(";") ? sql : `${sql};`, { encoding: "utf8" });
    try {
      return await this.psqlFile(file, opts);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async psqlFile(file, { database = "postgres", user = "postgres", password } = {}) {
    const { stdout } = await run(
      this.bin("psql"),
      // -t -A: только значения, без шапки и рамки. Иначе любая проверка
      // «пусто ли в ответе» всегда видит строку заголовка и врёт.
      ["-h", HOST, "-p", String(this.port), "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-f", file],
      {
        env: {
          ...process.env,
          PGPASSWORD: password,
          // Файлы мы пишем в UTF-8 и ответ хотим получить в ней же. Без этого
          // psql на Windows берёт кодировку из консоли, и русские значения
          // возвращаются набором вопросительных знаков.
          PGCLIENTENCODING: "UTF8",
        },
      }
    );
    // Windows заканчивает строки парой CR+LF. Дальше этот ответ попадает в
    // сообщения, где переводы строк заменяют пробелом, — и оставшийся CR
    // возвращает курсор в начало строки, затирая написанное. Ответ базы
    // должен выглядеть одинаково на всех системах.
    return stdout.replace(/\r\n/g, "\n");
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

module.exports = { LocalPostgres, freePort, HOST, readText, WINDOWS_CODES };
