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
 * 3. Папка назначения по умолчанию лежит рядом с данными, и это честно
 *    называется недостаточным: настоящая копия живёт на другом носителе.
 *    Программа обязана говорить об этом вслух, а не делать вид.
 */

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

class Backups {
  /**
   * @param {object} o
   * @param {object} o.layout   раскладка папки данных
   * @param {object} o.config   настройки (меняются: сюда пишется отчёт о копии)
   * @param {string} o.binDir   папка с pg_dump и pg_restore
   */
  constructor({ layout, config: cfg, binDir }) {
    this.layout = layout;
    this.config = cfg;
    this.binDir = binDir;
    this.timer = null;
    this.running = false;
  }

  bin(name) {
    return path.join(this.binDir, exe(name));
  }

  /** Куда складывать. Пусто в настройках — значит рядом с данными. */
  get folder() {
    return this.config.backup.folder || this.layout.backups;
  }

  /** Копия на том же диске переживёт удалённый файл, но не смерть диска. */
  get sameDisk() {
    const dest = path.resolve(this.folder);
    const data = path.resolve(this.layout.root);
    return dest === data || dest.startsWith(data + path.sep) || path.parse(dest).root === path.parse(data).root;
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

  /** Читаем копию обратно. Без этого «копия сделана» — ничем не подтверждённые слова. */
  async verifyDump(file) {
    const { stdout } = await run(this.bin("pg_restore"), ["--list", file], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const tables = (stdout.match(/TABLE DATA/g) || []).length;
    if (tables === 0) throw new Error("в копии нет ни одной таблицы с данными");
    return tables;
  }

  /** Оставляем последние N копий базы. Старые удаляем. */
  trim() {
    const dir = path.join(this.folder, "db");
    if (!fs.existsSync(dir)) return [];

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".dump"))
      .sort()
      .reverse();

    const extra = files.slice(Math.max(1, this.config.backup.keep));
    for (const f of extra) fs.rmSync(path.join(dir, f), { force: true });
    return extra;
  }

  /**
   * Одна копия: база, файлы, настройки.
   *
   * config.json кладём рядом намеренно: в нём пароли базы, и без него копия
   * восстанавливается, но программа не узнает свою же установку.
   */
  async run(reason = "по расписанию") {
    if (this.running) return { ok: false, error: "копия уже делается" };
    this.running = true;

    const started = Date.now();
    const dbDir = path.join(this.folder, "db");

    try {
      fs.mkdirSync(dbDir, { recursive: true });

      var file = freeName(dbDir, `finecrm-${stamp()}`);
      await this.dumpDatabase(file);
      const tables = await this.verifyDump(file);
      const bytes = fs.statSync(file).size;

      const files = mirror(this.layout.files, path.join(this.folder, "files"));
      fs.copyFileSync(this.layout.config, path.join(this.folder, "config.json"));
      const removed = this.trim();

      const report = {
        ok: true,
        at: new Date().toISOString(),
        reason,
        file,
        bytes,
        tables,
        photos: files.copied,
        removed: removed.length,
        ms: Date.now() - started,
      };
      this.remember(report);
      return report;
    } catch (err) {
      // Недоделанная копия опаснее отсутствующей: её посчитают за рабочую.
      if (file) fs.rmSync(file, { force: true });
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

module.exports = { Backups, mirror };
