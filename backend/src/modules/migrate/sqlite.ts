/**
 * Чтение таблиц из файла SQLite — без единой зависимости.
 *
 * Тот же разбор, что в утилите `tools/perenos/sqlite.js`, перенесённый в
 * сервер: сверен там с настоящим sqlite на живой базе (девять таблиц,
 * 15 тысяч строк, длинные комментарии в страницах переполнения).
 *
 * Почему не библиотека. Готовый драйвер sqlite — нативный модуль, его нужно
 * собирать под каждую версию Node, в облаке и в Основе они разные, а
 * встроенного `node:sqlite` в Node 20 (облако) нет вовсе. Читаем же мы мало:
 * последовательный обход дерева таблицы и разбор записи.
 *
 * Файл приходит от человека, а не от нас, поэтому разбор недоверчивый: на
 * каждую страницу заходим не больше одного раза (зацикленная ссылка в битом
 * файле иначе повесила бы сервер), цепочки переполнения и глубина дерева
 * ограничены, выход за пределы файла — понятная ошибка, а не падение.
 */

export type SqlValue = string | number | bigint | Buffer | null;
export type SqlRow = Record<string, SqlValue>;
export interface SqlTable {
  columns: string[];
  rows: SqlRow[];
}

/** Целое переменной длины: по 7 бит на байт, старший бит — «есть продолжение». */
function varint(buf: Buffer, pos: number): [bigint, number] {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    const byte = buf[pos + i];
    if (byte === undefined) throw new BadFile("запись обрывается посередине");
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, i + 1];
  }
  const last = buf[pos + 8];
  if (last === undefined) throw new BadFile("запись обрывается посередине");
  // Девятый байт отдаёт все восемь бит — иначе 64-разрядное число не влезает.
  value = (value << 8n) | BigInt(last);
  return [value, 9];
}

/** Число в разумных пределах отдаём обычным number: с BigInt неудобно всем. */
const small = (v: bigint): number | bigint =>
  v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v;

/** Файл не тот или битый — это ответ человеку, а не ошибка сервера. */
export class BadFile extends Error {}

const MAX_DEPTH = 32;

class SqliteFile {
  private readonly pageSize: number;
  private readonly usable: number;
  private seen = new Set<number>();

  constructor(private readonly buf: Buffer) {
    if (buf.length < 100 || buf.toString("latin1", 0, 15) !== "SQLite format 3") {
      throw new BadFile("это не файл базы SQLite");
    }
    const declared = buf.readUInt16BE(16);
    // 1 означает 65536: в два байта размер страницы иначе не записать.
    this.pageSize = declared === 1 ? 65536 : declared;
    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0) {
      throw new BadFile("в заголовке файла странный размер страницы — похоже, файл повреждён");
    }
    this.usable = this.pageSize - buf[20];
  }

  private page(n: number): Buffer {
    const start = (n - 1) * this.pageSize;
    if (n < 1 || start + this.pageSize > this.buf.length) {
      throw new BadFile(`файл обрывается: нет страницы ${n}. Возможно, база скопирована не целиком`);
    }
    return this.buf.subarray(start, start + this.pageSize);
  }

  /**
   * Полезная нагрузка ячейки. Длинная запись не помещается в страницу и
   * продолжается цепочкой страниц переполнения — именно на этом ломаются
   * самодельные читалки: короткие строки читаются верно, а первый же длинный
   * комментарий приезжает обрезанным.
   */
  private payload(page: Buffer, offset: number, size: number): Buffer {
    const X = this.usable - 35; // для листа таблицы
    if (size <= X) return page.subarray(offset, offset + size);

    const M = Math.floor(((this.usable - 12) * 32) / 255) - 23;
    const K = M + ((size - M) % (this.usable - 4));
    const local = K <= X ? K : M;

    const parts = [page.subarray(offset, offset + local)];
    let next = page.readUInt32BE(offset + local);
    let left = size - local;
    let hops = 0;

    while (next !== 0 && left > 0) {
      // Цепочка длиннее самого файла — это петля в битом файле, а не запись.
      if ((hops += 1) > this.buf.length / this.pageSize) throw new BadFile("зацикленная запись — файл повреждён");
      const p = this.page(next);
      const take = Math.min(left, this.usable - 4);
      parts.push(p.subarray(4, 4 + take));
      left -= take;
      next = p.readUInt32BE(0);
    }
    return Buffer.concat(parts);
  }

  /** Разбор записи: заголовок из «серийных типов», за ним значения подряд. */
  private record(buf: Buffer): SqlValue[] {
    const [headerBig, n] = varint(buf, 0);
    const headerSize = Number(headerBig);
    const types: number[] = [];
    let pos = n;
    while (pos < headerSize) {
      const [t, used] = varint(buf, pos);
      types.push(Number(t));
      pos += used;
    }

    const out: SqlValue[] = [];
    let data = headerSize;
    for (const t of types) {
      if (t === 0) out.push(null);
      else if (t >= 1 && t <= 6) {
        // Целые лежат со знаком, длиной 1, 2, 3, 4, 6 или 8 байт.
        const bytes = [0, 1, 2, 3, 4, 6, 8][t];
        if (data + bytes > buf.length) throw new BadFile("запись обрывается посередине");
        out.push(bytes === 8 ? small(buf.readBigInt64BE(data)) : buf.readIntBE(data, bytes));
        data += bytes;
      } else if (t === 7) {
        if (data + 8 > buf.length) throw new BadFile("запись обрывается посередине");
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
  rows(rootPage: number, out: Array<{ rowid: number | bigint; values: SqlValue[] }> = [], depth = 0) {
    if (depth > MAX_DEPTH) throw new BadFile("слишком глубокое дерево таблицы — файл повреждён");
    if (this.seen.has(rootPage)) throw new BadFile("страница встречается дважды — файл повреждён");
    this.seen.add(rootPage);

    const page = this.page(rootPage);
    const base = rootPage === 1 ? 100 : 0;
    const type = page[base];
    const cells = page.readUInt16BE(base + 3);

    if (type === 0x05) {
      for (let i = 0; i < cells; i += 1) {
        const ptr = page.readUInt16BE(base + 12 + i * 2);
        this.rows(page.readUInt32BE(ptr), out, depth + 1);
      }
      this.rows(page.readUInt32BE(base + 8), out, depth + 1); // самый правый потомок
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
 * Имена колонок — из текста CREATE TABLE: ничего другого в файле нет. Разбор
 * нарочно грубый — имя это первое слово объявления, — но именно так эти
 * объявления и выглядят у программ, которые мы переносим.
 */
export function columnsOf(sql: string): string[] {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close < open) return [];

  const inner = sql.slice(open + 1, close);
  const parts: string[] = [];
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
    .map((p) => p.trim().split(/\s+/)[0].replace(/^["'`[]|["'`\]]$/g, ""))
    .filter((name) => name && !/^(primary|unique|check|foreign|constraint)$/i.test(name));
}

/** Таблицы файла: имя → { columns, rows }. */
export function readTables(buf: Buffer): Record<string, SqlTable> {
  const db = new SqliteFile(buf);
  const tables: Record<string, SqlTable> = {};

  for (const { values } of db.rows(1)) {
    const [type, name, , rootPage, sql] = values;
    if (type !== "table" || String(name).startsWith("sqlite_")) continue;

    const columns = columnsOf(String(sql ?? ""));
    const rows = db.rows(Number(rootPage)).map(({ rowid, values: v }) => {
      const row: SqlRow = {};
      columns.forEach((col, i) => {
        // INTEGER PRIMARY KEY хранится не в записи, а в номере строки: на
        // его месте лежит NULL, и колонка id иначе приехала бы пустой.
        row[col] = v[i] === null && i === 0 ? rowid : (v[i] ?? null);
      });
      return row;
    });

    tables[String(name)] = { columns, rows };
  }
  return tables;
}
