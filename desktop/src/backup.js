"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const run = promisify(execFile);
const config = require("./config");

/**
 * Резервные копии.
 *
 * В облаке база переживает смерть диска, в коробке — нет. Один сдохший
 * винчестер в мастерской, и вся история ремонтов исчезает вместе с ним.
 * Поэтому копии здесь не настройка на будущее, а часть первого запуска.
 *
 * Три решения, за которыми стоит чужой горький опыт:
 *
 * 1. База копируется через pg_dump, а не копированием папки кластера. Копия
 *    живой папки — это копия недописанных страниц: восстановить её нельзя, а
 *    узнают об этом в тот единственный день, когда она понадобится.
 * 2. Каждая копия сразу читается обратно pg_restore. Копия, которую никто не
 *    проверял, — не копия, а надежда.
 * 3. Основная копия лежит рядом с данными, и это честно называется
 *    недостаточным: настоящая копия живёт на другом носителе. Поэтому мест
 *    может быть несколько — второй диск, флешка, сетевая папка, — и каждая
 *    копия идёт во все.
 *
 * Что лежит в каждом месте:
 *
 *   db/finecrm-<дата-время>.dump   копия базы (хранится N последних)
 *   db/finecrm-<дата-время>.json   что в ней: мастерская, версия, заказов
 *   files/                         фотографии — досылаются только новые
 *   config.json                    настройки установки
 *   Как восстановить.txt           для человека, который найдёт папку
 *
 * В дополнительном месте всё это — внутри папки «FineCRM копии», чтобы не
 * рассыпать файлы по корню флешки.
 */

/** Папка копий внутри выбранного человеком места. */
const PLACE_DIR = "FineCRM копии";

const stamp = (d = new Date()) =>
  [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-") +
  "-" +
  // Секунды в имени нужны не для красоты: без них копия, сделанная руками
  // сразу после суточной, молча затирала бы её — а это ровно тот случай,
  // когда человек нажимает «сделать копию», потому что нервничает за данные.
  [
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");

const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);

/**
 * Имя, которого ещё нет.
 *
 * Ни одна копия не должна молча затирать другую — даже если две сделаны в
 * одну и ту же секунду. Затёртая копия обнаруживается только тогда, когда
 * она понадобилась, то есть слишком поздно.
 */
function freeName(dir, base) {
  let file = path.join(dir, `${base}.dump`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.dump`);
  return file;
}

/** Копирует в приёмник то, чего в нём ещё нет. Удалённое не трогаем. */
function mirror(from, to) {
  let copied = 0;
  let bytes = 0;
  if (!fs.existsSync(from)) return { copied, bytes };

  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const inner = mirror(src, dst);
      copied += inner.copied;
      bytes += inner.bytes;
      continue;
    }
    if (!entry.isFile()) continue;

    const st = fs.statSync(src);
    // Сравниваем размер, а не время: файлы снимков не меняются после
    // загрузки, а время правки у копии всегда своё.
    let same = false;
    try {
      same = fs.statSync(dst).size === st.size;
    } catch {
      same = false;
    }
    if (same) continue;

    fs.copyFileSync(src, dst);
    copied += 1;
    bytes += st.size;
  }
  return { copied, bytes };
}

/** Сколько файлов в папке, со всеми вложенными. Для отчёта о фотографиях. */
function countFiles(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

/** Куда класть копии в выбранном месте. Выбрали саму «FineCRM копии» — не вкладываем вторую. */
function placeDir(placePath) {
  return path.basename(path.resolve(placePath)) === PLACE_DIR ? path.resolve(placePath) : path.join(placePath, PLACE_DIR);
}

/** Один диск или нет — по корню пути (C:\, D:\, \\сервер\папка). */
function sameRoot(a, b) {
  const ra = path.parse(path.resolve(a)).root.toLowerCase();
  const rb = path.parse(path.resolve(b)).root.toLowerCase();
  return ra === rb;
}

const README = `Резервные копии FineCRM.

Здесь лежат копии базы мастерской (папка db) и фотографии заказов (папка files).

Как восстановить после поломки компьютера или диска:
1. Установите FineCRM на исправный компьютер.
2. На первом экране выберите «Основа», затем «Восстановить из резервной копии».
3. Укажите эту папку (или флешку, на которой она лежит) и выберите копию.

Программа сама развернёт базу и вернёт фотографии. Логины и пароли сотрудников,
настройки и доступ из интернета хранятся в самой базе и вернутся вместе с ней.

Файлы здесь руками не переименовывайте и не удаляйте: программа сама хранит
несколько последних копий и убирает старые.
`;

class Backups {
  /**
   * @param {object} o
   * @param {object} o.layout   раскладка папки данных
   * @param {object} o.config   настройки (меняются: сюда пишется отчёт о копии)
   * @param {string} o.binDir   папка с pg_dump и pg_restore
   * @param {string} [o.appVersion] версия программы — пишется в описание копии
   * @param {string} [o.migrationsDir] папка миграций сервера — по ней
   *        проверяется, не новее ли копия программы, которая её поднимает
   */
  constructor({ layout, config: cfg, binDir, appVersion = null }) {
    this.layout = layout;
    this.config = cfg;
    this.binDir = binDir;
    this.appVersion = appVersion;
    this.timer = null;
    this.running = false;
  }

  bin(name) {
    return path.join(this.binDir, exe(name));
  }

  /** Основная копия — всегда рядом с данными. Прежняя «своя папка» переехала в места. */
  get folder() {
    return this.config.backup.folder || this.layout.backups;
  }

  /** Все места, куда идёт копия: сначала основное, потом дополнительные. */
  destinations() {
    return [
      { path: this.folder, dir: this.folder, primary: true },
      ...this.config.backup.places.map((p) => ({ path: p.path, dir: placeDir(p.path), primary: false, place: p })),
    ];
  }

  /**
   * Копия на том же диске переживёт удалённый файл, но не смерть диска.
   * Надёжно — только если хоть одно место на другом диске или в сети.
   */
  get sameDisk() {
    return this.destinations().every((d) => sameRoot(d.dir, this.layout.root));
  }

  /** Когда положено делать следующую: раз в сутки, в заданный час. */
  due(now = new Date()) {
    if (!this.config.backup.enabled) return false;

    const last = this.config.backup.lastAt ? new Date(this.config.backup.lastAt) : null;
    if (!last || Number.isNaN(last.getTime())) return true;

    const hours = (now - last) / 3_600_000;
    if (hours >= 24) return true;
    // Наступил назначенный час, а сегодня копии ещё не было — самый частый
    // случай: компьютер включили утром, а копия делается вечером.
    return now.getHours() >= this.config.backup.atHour && last.toDateString() !== now.toDateString();
  }

  /** Недавно уже копировали — при выходе второй раз подряд не надо. */
  freshWithin(minutes, now = new Date()) {
    const b = this.config.backup;
    if (!b.lastOk || !b.lastAt) return false;
    return now - new Date(b.lastAt) < minutes * 60_000;
  }

  /**
   * Снимок базы.
   *
   * Читаем под суперпользователем, а не под владельцем схемы, и это не
   * небрежность. На таблицах стоит FORCE ROW LEVEL SECURITY — изоляция
   * мастерских действует даже для владельца таблиц, и pg_dump под ним
   * получает «query would be affected by row-level security policy», то есть
   * копию без единой строки. Суперпользователь — единственная роль, которая
   * видит базу целиком, и снимать копию имеет право только он.
   */
  async dumpDatabase(file) {
    const db = this.config.db;
    await run(
      this.bin("pg_dump"),
      [
        "-h", "127.0.0.1",
        "-p", String(db.port),
        "-U", "postgres",
        "-d", db.name,
        // Формат custom: один файл, сжатый, и из него можно достать как всю
        // базу, так и одну таблицу. Обычный SQL-текст весил бы втрое больше.
        "-Fc",
        "-f", file,
      ],
      { env: { ...process.env, PGPASSWORD: db.ownerPassword }, maxBuffer: 64 * 1024 * 1024 }
    );
  }

  /** Короткий ответ базы одной строкой — для описания копии. Не вышло — null. */
  async ask(sql) {
    const db = this.config.db;
    try {
      const { stdout } = await run(
        this.bin("psql"),
        ["-h", "127.0.0.1", "-p", String(db.port), "-U", "postgres", "-d", db.name, "-tAX", "-c", sql],
        { env: { ...process.env, PGPASSWORD: db.ownerPassword, PGCLIENTENCODING: "UTF8" } }
      );
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Что в копии — для экрана восстановления: какая мастерская, сколько
   * заказов, какой версией сделана. Без этого человек выбирал бы из списка
   * дат, не понимая, что за ними.
   *
   * Последняя миграция нужна, чтобы старая программа не взялась поднимать
   * копию, сделанную новой: структура базы в ней ей незнакома.
   */
  async describe(reason) {
    const orders = await this.ask('SELECT count(*) FROM "Order" WHERE "deletedAt" IS NULL');
    const migration = await this.ask(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1"
    );
    return {
      format: 1,
      createdAt: new Date().toISOString(),
      reason,
      workshop: this.config.workshopName || null,
      appVersion: this.appVersion,
      orders: orders !== null && /^\d+$/.test(orders) ? Number(orders) : null,
      photos: countFiles(this.layout.files),
      lastMigration: migration || null,
    };
  }

  /** Читаем копию обратно. Без этого «копия сделана» — ничем не подтверждённые слова. */
  async verifyDump(file) {
    const { stdout } = await run(this.bin("pg_restore"), ["--list", file], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const tables = (stdout.match(/TABLE DATA/g) || []).length;
    if (tables === 0) throw new Error("в копии нет ни одной таблицы с данными");
    return tables;
  }

  /** Оставляем последние N копий базы в папке места. Старые удаляем вместе с описаниями. */
  trim(dir = this.folder) {
    const dbDir = path.join(dir, "db");
    if (!fs.existsSync(dbDir)) return [];

    const files = fs
      .readdirSync(dbDir)
      .filter((f) => f.endsWith(".dump"))
      .sort()
      .reverse();

    const extra = files.slice(Math.max(1, this.config.backup.keep));
    for (const f of extra) {
      fs.rmSync(path.join(dbDir, f), { force: true });
      fs.rmSync(path.join(dbDir, f.replace(/\.dump$/, ".json")), { force: true });
    }
    return extra;
  }

  /** Разложить готовую копию по одному месту: база, описание, фото, настройки. */
  async deliver(dir, dump, info, { copyDump }) {
    const dbDir = path.join(dir, "db");
    fs.mkdirSync(dbDir, { recursive: true });

    let file = dump;
    if (copyDump) {
      file = freeName(dbDir, path.basename(dump, ".dump"));
      // Через временное имя: выдернутая посреди записи флешка не должна
      // оставить недописанный файл под видом копии.
      const tmp = `${file}.part`;
      fs.copyFileSync(dump, tmp);
      if (fs.statSync(tmp).size !== fs.statSync(dump).size) {
        fs.rmSync(tmp, { force: true });
        throw new Error("копия записалась не целиком");
      }
      fs.renameSync(tmp, file);
    }
    fs.writeFileSync(file.replace(/\.dump$/, ".json"), JSON.stringify(info, null, 2), "utf8");

    const photos = mirror(this.layout.files, path.join(dir, "files"));
    fs.copyFileSync(this.layout.config, path.join(dir, "config.json"));
    try {
      fs.writeFileSync(path.join(dir, "Как восстановить.txt"), README, "utf8");
    } catch {
      /* подсказка — не копия; не записалась, и ладно */
    }
    const removed = this.trim(dir);
    return { file, photos: photos.copied, removed: removed.length };
  }

  /**
   * Одна копия: база, фотографии, настройки — во все места.
   *
   * Сначала основное место, рядом с данными: там снимается и проверяется
   * копия базы. Не вышло — копии нет вовсе, и об этом надо сказать. Потом
   * тот же файл разъезжается по остальным местам. Недоступное место (флешку
   * вынули, сеть упала) не срывает остальные: у него просто свой отчёт.
   */
  async run(reason = "по расписанию") {
    if (this.running) return { ok: false, error: "копия уже делается" };
    this.running = true;

    const started = Date.now();
    const dbDir = path.join(this.folder, "db");
    let file = null;

    try {
      fs.mkdirSync(dbDir, { recursive: true });

      file = freeName(dbDir, `finecrm-${stamp()}`);
      await this.dumpDatabase(file);
      const tables = await this.verifyDump(file);
      const bytes = fs.statSync(file).size;
      const info = { ...(await this.describe(reason)), bytes, tables };

      const main = await this.deliver(this.folder, file, info, { copyDump: false });

      const places = [];
      for (const d of this.destinations().filter((x) => !x.primary)) {
        const at = new Date().toISOString();
        try {
          // Место — это то, что выбрал человек. Нет самой выбранной папки —
          // значит, нет диска или флешки: создавать её заново на месте
          // пропавшей флешки нельзя, копия легла бы на системный диск.
          if (!fs.existsSync(d.path)) throw new Error("место недоступно — диск не подключён или папки больше нет");
          const got = await this.deliver(d.dir, file, info, { copyDump: true });
          Object.assign(d.place, { lastAt: at, lastOk: true, lastError: null });
          places.push({ path: d.path, ok: true, photos: got.photos });
        } catch (err) {
          Object.assign(d.place, { lastAt: at, lastOk: false, lastError: err.message });
          places.push({ path: d.path, ok: false, error: err.message });
        }
      }

      const report = {
        ok: true,
        at: new Date().toISOString(),
        reason,
        file: main.file,
        bytes,
        tables,
        photos: main.photos,
        removed: main.removed,
        places,
        placesFailed: places.filter((p) => !p.ok).length,
        ms: Date.now() - started,
      };
      this.remember(report);
      return report;
    } catch (err) {
      // Недоделанная копия опаснее отсутствующей: её посчитают за рабочую.
      if (file) {
        fs.rmSync(file, { force: true });
        fs.rmSync(file.replace(/\.dump$/, ".json"), { force: true });
      }
      const report = { ok: false, at: new Date().toISOString(), reason, error: err.message };
      this.remember(report);
      return report;
    } finally {
      this.running = false;
    }
  }

  /** Отчёт о последней копии живёт в настройках — его показывает интерфейс. */
  remember(report) {
    this.config.backup.lastAt = report.at;
    this.config.backup.lastOk = report.ok;
    this.config.backup.lastError = report.ok ? null : report.error;
    this.config.backup.lastBytes = report.bytes ?? null;
    try {
      config.write(this.layout.config, this.config);
    } catch {
      /* не записалось — копия от этого не перестала существовать */
    }
  }

  /** Добавить место. Проверяем сразу, а не при первой копии через сутки. */
  addPlace(placePath) {
    const resolved = path.resolve(String(placePath || ""));
    if (!placePath || !fs.existsSync(resolved)) return { ok: false, error: "Такой папки нет" };
    const data = path.resolve(this.layout.root);
    if (resolved === data || resolved.startsWith(data + path.sep)) {
      return { ok: false, error: "Это папка самой базы — копия в ней пропадёт вместе с базой. Выберите другое место." };
    }
    if (this.config.backup.places.some((p) => path.resolve(p.path) === resolved)) {
      return { ok: false, error: "Это место уже в списке" };
    }
    try {
      const dir = placeDir(resolved);
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.проверка-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
    } catch (err) {
      return { ok: false, error: `В эту папку нельзя записать: ${err.message}` };
    }
    this.config.backup.places.push({ path: resolved, lastAt: null, lastOk: null, lastError: null });
    config.write(this.layout.config, this.config);
    return { ok: true, sameDisk: sameRoot(resolved, this.layout.root) };
  }

  /** Убрать место из списка. Уже сделанные там копии не трогаем — они чьи-то. */
  removePlace(placePath) {
    const resolved = path.resolve(String(placePath || ""));
    const before = this.config.backup.places.length;
    this.config.backup.places = this.config.backup.places.filter((p) => path.resolve(p.path) !== resolved);
    if (this.config.backup.places.length === before) return { ok: false, error: "Такого места в списке нет" };
    config.write(this.layout.config, this.config);
    return { ok: true };
  }

  /** Состояние для интерфейса: места, отчёты, сколько хранится. */
  status() {
    const b = this.config.backup;
    return {
      enabled: b.enabled,
      keep: b.keep,
      onExit: b.onExit,
      atHour: b.atHour,
      running: this.running,
      last: { at: b.lastAt, ok: b.lastOk, error: b.lastError, bytes: b.lastBytes },
      sameDisk: this.sameDisk,
      places: this.destinations().map((d) => ({
        path: d.path,
        dir: d.dir,
        primary: d.primary,
        available: fs.existsSync(d.path),
        sameDisk: sameRoot(d.dir, this.layout.root),
        lastAt: d.primary ? b.lastAt : d.place.lastAt,
        lastOk: d.primary ? b.lastOk : d.place.lastOk,
        lastError: d.primary ? b.lastError : d.place.lastError,
        copies: countDumps(d.dir),
      })),
    };
  }

  /**
   * Сторож. Просыпается раз в полчаса и смотрит, не пора ли.
   *
   * Не «ровно в 20:00»: компьютер в мастерской в это время может быть
   * выключен, и копия не сделалась бы вовсе. Проверка по факту — «сегодня
   * копии ещё не было» — переживает и выключения, и обеденный перерыв.
   */
  start(onDone = () => {}) {
    if (this.timer) return;
    const tick = async () => {
      if (this.due()) onDone(await this.run());
    };
    this.timer = setInterval(tick, 30 * 60 * 1000);
    if (this.timer.unref) this.timer.unref();
    setTimeout(tick, 60 * 1000); // первый раз — через минуту после запуска
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function countDumps(dir) {
  try {
    return fs.readdirSync(path.join(dir, "db")).filter((f) => f.endsWith(".dump")).length;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------ восстановление

/**
 * Найти копии в папке, которую указал человек.
 *
 * Указать могут что угодно: саму «FineCRM копии», флешку, на которой она
 * лежит, старую папку данных с её подпапкой backups или прежнюю «свою
 * папку» копий. Проверяем все эти варианты, а не требуем попасть точно.
 */
function findBackups(chosen) {
  const base = path.resolve(String(chosen || ""));
  const candidates = [base, path.join(base, PLACE_DIR), path.join(base, "backups"), path.join(base, "backups", PLACE_DIR)];

  for (const root of candidates) {
    const dbDir = path.join(root, "db");
    let names = [];
    try {
      names = fs.readdirSync(dbDir).filter((f) => f.endsWith(".dump"));
    } catch {
      continue;
    }
    if (names.length === 0) continue;

    const dumps = names
      .sort()
      .reverse()
      .map((name) => {
        const file = path.join(dbDir, name);
        let info = null;
        try {
          info = JSON.parse(fs.readFileSync(file.replace(/\.dump$/, ".json"), "utf8"));
        } catch {
          /* копия старой версии — без описания; дату берём из имени */
        }
        const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})?/.exec(name);
        const at = info?.createdAt ?? (m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).toISOString() : null);
        return { file, name, at, bytes: fs.statSync(file).size, info };
      });

    return {
      ok: true,
      root,
      dumps,
      photos: countFiles(path.join(root, "files")),
      hasConfig: fs.existsSync(path.join(root, "config.json")),
    };
  }
  return { ok: false, error: "В этой папке резервных копий FineCRM не нашлось. Укажите папку «FineCRM копии» или диск, на котором она лежит." };
}

/**
 * Не новее ли копия программы, которая берётся её поднять.
 *
 * Копия от старой версии годится: после восстановления миграции доведут базу
 * до нынешней. А в копии от новой есть таблицы, о которых эта программа не
 * знает, — она либо упадёт, либо испортит данные. Лучше честно отказать.
 */
function tooNew(info, migrationsDir) {
  if (!info || !info.lastMigration || !migrationsDir) return null;
  let known = [];
  try {
    known = fs.readdirSync(migrationsDir).filter((d) => /^\d{14}_/.test(d));
  } catch {
    return null;
  }
  if (known.includes(info.lastMigration)) return null;
  const newest = known.sort().pop();
  if (newest && info.lastMigration > newest) {
    return `Копия сделана более новой версией FineCRM${info.appVersion ? ` (${info.appVersion})` : ""}. Сначала обновите программу, потом восстанавливайте.`;
  }
  return null;
}

/**
 * Развернуть копию базы в пустую, только что созданную базу.
 *
 * Под суперпользователем — копия снималась им же, и в ней есть всё: таблицы,
 * права роли приложения, правила построчной изоляции. `--role` делает
 * владельцем всего владельца схемы, как при обычной установке, а не
 * суперпользователя: иначе миграции потом не смогли бы менять таблицы.
 * Одной транзакцией: сорвалось посередине — базы нет вовсе, а не половина.
 */
async function restoreDump({ binDir, port, db, superPassword, file }) {
  await run(
    path.join(binDir, exe("pg_restore")),
    [
      "-h", "127.0.0.1",
      "-p", String(port),
      "-U", "postgres",
      "-d", db.name,
      "--no-owner",
      `--role=${db.ownerUser}`,
      "--single-transaction",
      "--exit-on-error",
      file,
    ],
    { env: { ...process.env, PGPASSWORD: superPassword, PGCLIENTENCODING: "UTF8" }, maxBuffer: 64 * 1024 * 1024 }
  );
}

module.exports = { Backups, mirror, findBackups, tooNew, restoreDump, placeDir, countFiles, PLACE_DIR };
