"use strict";

/**
 * Чтение таблиц из файла .sqlite — без единой зависимости.
 *
 * Зачем свой разбор, когда есть готовые библиотеки. Утилита переноса
 * запускается один раз в чужой мастерской, на чужом компьютере, где ничего,
 * кроме Node, может и не оказаться. Готовый драйвер sqlite — это нативный
 * модуль: его нужно собрать под версию Node и разрядность системы, и первое
 * же «не удалось установить» превращает пятиминутный перенос в переписку на
 * два дня. Встроенный `node:sqlite` появился только в Node 22 и объявлен
 * экспериментальным — рассчитывать на него в 2026 году ещё рано.
 *
 * Читаем мы при этом мало: последовательный обход дерева таблицы и разбор
 * записи. Ни индексов, ни запросов, ни записи — всё это здесь не нужно.
 *
 * Формат описан в https://www.sqlite.org/fileformat.html; ниже в комментариях
 * только то, на чём легко ошибиться.
 */

const fs = require("fs");

/** Целое переменной длины: по 7 бит на байт, старший бит — «есть продолжение». */
function varint(buf, pos) {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    const byte = buf[pos + i];
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, i + 1];
  }
  // Девятый байт отдаёт все восемь бит — иначе 64-разрядное число не влезает.
  value = (value << 8n) | BigInt(buf[pos + 8]);
  return [value, 9];
}

/** Число в разумных пределах отдаём обычным number: с BigInt неудобно всем. */
const small = (v) => (v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v);

class SqliteFile {
  constructor(buf) {
    if (buf.length < 100 || buf.toString("latin1", 0, 15) !== "SQLite format 3") {
      throw new Error("это не файл SQLite");
    }
    this.buf = buf;
    const declared = buf.readUInt16BE(16);
    // 1 означает 65536: в два байта размер страницы иначе не записать.
    this.pageSize = declared === 1 ? 65536 : declared;
    this.reserved = buf[20];
    this.usable = this.pageSize - this.reserved;
  }

  page(n) {
    const start = (n - 1) * this.pageSize;
    if (start + this.pageSize > this.buf.length) throw new Error(`страницы ${n} нет в файле`);
    return this.buf.subarray(start, start + this.pageSize);
  }

  /**
   * Полезная нагрузка ячейки. Длинная запись не помещается в страницу и
   * продолжается цепочкой страниц переполнения — именно на этом ломаются
   * самодельные читалки: короткие строки читаются верно, а первый же длинный
   * комментарий приезжает обрезанным, и заметить это без сверки нельзя.
   */
  payload(page, offset, size) {
    const X = this.usable - 35; // для листа таблицы
    if (size <= X) return page.subarray(offset, offset + size);

    const M = Math.floor(((this.usable - 12) * 32) / 255) - 23;
    const K = M + ((size - M) % (this.usable - 4));
    const local = K <= X ? K : M;

    const parts = [page.subarray(offset, offset + local)];
    let next = page.readUInt32BE(offset + local);
    let left = size - local;

    while (next !== 0 && left > 0) {
      const p = this.page(next);
      const take = Math.min(left, this.usable - 4);
      parts.push(p.subarray(4, 4 + take));
      left -= take;
      next = p.readUInt32BE(0);
    }
    return Buffer.concat(parts);
  }

  /** Разбор записи: заголовок из «серийных типов», за ним значения подряд. */
  record(buf) {
    let [headerSize, n] = varint(buf, 0);
    headerSize = Number(headerSize);
    const types = [];
    let pos = n;
    while (pos < headerSize) {
      const [t, used] = varint(buf, pos);
      types.push(Number(t));
      pos += used;
    }

    const out = [];
    let data = headerSize;
    for (const t of types) {
      if (t === 0) out.push(null);
      else if (t >= 1 && t <= 6) {
        // Целые лежат со знаком, длиной 1, 2, 3, 4, 6 или 8 байт. Восемь байт
        // readIntBE не умеет — там свой вызов.
        const bytes = [0, 1, 2, 3, 4, 6, 8][t];
        out.push(bytes === 8 ? small(buf.readBigInt64BE(data)) : buf.readIntBE(data, bytes));
        data += bytes;
      } else if (t === 7) {
        out.push(buf.readDoubleBE(data));
        data += 8;
      } else if (t === 8) out.push(0);
      else if (t === 9) out.push(1);
      else if (t >= 12 && t % 2 === 0) {
        const len = (t - 12) / 2;
        out.push(buf.subarray(data, data + len));
        data += len;
      } else if (t >= 13) {
        const len = (t - 13) / 2;
        // Кодировка объявлена в заголовке файла, но не-UTF-8 базы в дикой
        // природе встречаются реже, чем битые: читаем как UTF-8.
        out.push(buf.toString("utf8", data, data + len));
        data += len;
      } else out.push(null);
    }
    return out;
  }

  /** Обход дерева таблицы слева направо: только листья, только по порядку. */
  rows(rootPage, out = []) {
    const page = this.page(rootPage);
    const base = rootPage === 1 ? 100 : 0;
    const type = page[base];
    const cells = page.readUInt16BE(base + 3);

    if (type === 0x05) {
      const headerLen = 12;
      for (let i = 0; i < cells; i += 1) {
        const ptr = page.readUInt16BE(base + headerLen + i * 2);
        this.rows(page.readUInt32BE(ptr), out);
      }
      this.rows(page.readUInt32BE(base + 8), out); // самый правый потомок
      return out;
    }

    if (type !== 0x0d) return out; // индексы нам не нужны

    for (let i = 0; i < cells; i += 1) {
      const ptr = page.readUInt16BE(base + 8 + i * 2);
      const [size, n1] = varint(page, ptr);
      const [rowid, n2] = varint(page, ptr + n1);
      const body = this.payload(page, ptr + n1 + n2, Number(size));
      out.push({ rowid: small(rowid), values: this.record(body) });
    }
    return out;
  }
}

/**
 * Таблицы файла: имя → { columns, rows }.
 *
 * Имена колонок берём из текста CREATE TABLE, потому что ничего другого в
 * файле нет. Разбор нарочно грубый — имя это первое слово объявления, — но
 * именно так эти объявления и выглядят у программ, которые мы переносим.
 */
function readTables(file) {
  const db = new SqliteFile(fs.readFileSync(file));
  const tables = {};

  for (const { values } of db.rows(1)) {
    const [type, name, , rootPage, sql] = values;
    if (type !== "table" || String(name).startsWith("sqlite_")) continue;

    const columns = columnsOf(String(sql ?? ""));
    const rows = db.rows(Number(rootPage)).map(({ rowid, values: v }) => {
      const row = {};
      columns.forEach((col, i) => {
        // INTEGER PRIMARY KEY хранится не в записи, а в номере строки: на
        // его месте лежит NULL, и колонка id иначе приехала бы пустой.
        row[col] = v[i] === null && i === 0 ? rowid : v[i];
      });
      return row;
    });

    tables[String(name)] = { columns, rows };
  }
  return tables;
}

function columnsOf(sql) {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close < open) return [];

  const inner = sql.slice(open + 1, close);
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);

  return parts
    .map((p) => p.trim().split(/\s+/)[0].replace(/^["'`\[]|["'`\]]$/g, ""))
    .filter((name) => name && !/^(primary|unique|check|foreign|constraint)$/i.test(name));
}

module.exports = { readTables, SqliteFile };
