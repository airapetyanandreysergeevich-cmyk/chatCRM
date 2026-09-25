import type { TableRow } from "../../data/tableFile";
import type { SqlTable } from "../sqlite";
import type { Converted, MigrationHistory, MigrationPayment, MigrationSource, MigrationStaff } from "./types";

/**
 * Старая программа учёта ремонтов с базой `baza.sqlite`: таблицы Catalog
 * (заказы), ClientsMap (клиенты), StatesMap (история статусов), Stock (склад).
 *
 * Правила разбора пришли из утилиты `tools/perenos`, где их вывели на двух
 * живых базах, и дополнены тем, чего утилита не умела: деньгами, мастерами,
 * историей статусов, гарантией в днях и месяцах и комплектностью отдельным
 * полем. Каждое правило ниже — ответ на то, что лежит в настоящих базах, а не
 * догадка.
 */

// --------------------------------------------------------------- инструменты

const trim = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();

/** В старой программе пустое поле нередко — это дефис. */
const clean = (v: unknown) => {
  const s = trim(v);
  return s === "-" || s === "—" || s === "," ? "" : s;
};

const num = (v: unknown) => {
  const n = Number(clean(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

/** «13-03-2023 13:05» (и «13-03-2023 13-05» в истории) → Date в местном времени. */
export function toDate(v: unknown): Date | null {
  const m = clean(v).match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?:[ T]+(\d{1,2})[:.-](\d{2}))?/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * Date → «дд.мм.гггг чч:мм», как читает загрузка. Полночь у старой программы
 * означает «время не заполняли», а не «выдали в полночь» — её не пишем.
 */
function ru(d: Date | null): string {
  if (!d) return "";
  const day = `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`;
  return d.getHours() || d.getMinutes() ? `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}` : day;
}

const plusDays = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

/**
 * Телефоны из ячейки. В одной ячейке их бывает два — через запятую, точку с
 * запятой, а то и слитно: «8921050877289211230321» — это два номера по
 * одиннадцать цифр подряд. Номер из одной повторённой цифры — не номер, а
 * «клиент телефон не дал».
 */
export function phones(raw: unknown): string[] {
  const out: string[] = [];
  for (const run of clean(raw).match(/\d[\d\s()+-]*\d/g) ?? []) {
    let digits = run.replace(/\D/g, "");
    const pieces: string[] = [];
    while (digits.length >= 21 && /^[78]/.test(digits)) {
      pieces.push(digits.slice(0, 11));
      digits = digits.slice(11);
    }
    pieces.push(digits);
    for (const p of pieces) {
      const tel = phone(p);
      if (tel && !out.includes(tel)) out.push(tel);
    }
  }
  return out;
}

function phone(digits: string): string {
  if (digits.length < 10 || digits.length > 12 || /^(\d)\1+$/.test(digits)) return "";
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return "+7" + digits.slice(1);
  if (digits.length === 10) return "+7" + digits;
  return "+" + digits;
}

/** «СТАЦЕНКО АРТЁМ» → «Стаценко Артём»: в старой программе всё капсом. */
export const caps = (v: unknown) =>
  clean(v)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/(^|[\s(«"'-])([а-яёa-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

/** Галочка: «0» и пусто — нет. «-1» встречается и тоже не «да». */
const flag = (v: unknown) => {
  const s = clean(v).toLowerCase();
  return s === "1" || s === "true" || s === "да";
};

const asIs = (v: unknown) => clean(v).replace(/\s+/g, " ");

/** Название позиции склада: капс выключаем, слова не трогаем. */
const sentence = (v: unknown) => {
  const s = clean(v).replace(/\s+/g, " ").toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
};

/** Список «Аппарат, акб, зарядное уст-во,» — без хвостовых запятых и пустых кусков. */
const list = (v: unknown) =>
  clean(v)
    .split(/[,\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "-")
    .join(", ");

/**
 * Текст для строки состава: «Замена клавиатуры, чистка — 1500». Разделители
 * позиций (точка с запятой, тире между пробелами, переводы строк) из названия
 * убираем — иначе при загрузке одна работа разъехалась бы на несколько.
 */
const lineName = (v: unknown) =>
  clean(v)
    .replace(/[\r\n]+/g, ", ")
    .replace(/;/g, ",")
    .replace(/\s[—–-]\s/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[,\s]+$/g, "")
    .replace(/^[,\s]+/g, "")
    .slice(0, 190);

/** Гарантия «30 дней», «3 месяца», «1 год» → дни. «Без гарантии» и непонятное — ноль. */
export function warrantyDays(v: unknown): number {
  const s = clean(v).toLowerCase();
  if (!s || s.startsWith("без")) return 0;
  const n = Number(s.match(/\d+/)?.[0] ?? (/(год|мес|нед)/.test(s) ? 1 : 0));
  if (/мес/.test(s)) return n * 30;
  if (/(год|лет)/.test(s)) return n * 365;
  if (/нед/.test(s)) return n * 7;
  return n;
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};
export const latin = (name: string) =>
  name
    .toLowerCase()
    .split("")
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 30) || "master";

const STATUS: Record<string, string> = {
  "выдан": "Выдан",
  "готов": "Готов",
  "принят в работу": "В работе",
  "диагностика": "Диагностика",
  "согласовано": "В работе",
  "согласование с клиентом": "Ожидает согласования",
  "ждёт запчасть": "Ожидание запчасти",
  "ждет запчасть": "Ожидание запчасти",
  "принят по гарантии": "Диагностика",
};

/** «Миша и Сергей» — это не человек. Берём первого, остальных пишем в примечание. */
function masterOf(raw: unknown): { name: string; all: string } {
  const all = caps(raw);
  if (!all || /^(другой|другое|нет|-)$/i.test(all)) return { name: "", all };
  const first = clean(raw).split(/\s+(?:и|and)\s+|\s*[,/+&]\s*/i)[0];
  return { name: caps(first), all };
}

/**
 * Комментарий мастера без служебного мусора старой программы.
 *
 * Программа сама дописывала в комментарий журнал галочек («+====… Установлена
 * галочка требует согласования …___») и хранила там же пароль от устройства в
 * рамке из черт. Журнал выбрасываем — он про программу, а не про ремонт.
 * Пароль достаём отдельно: у нас для него своё поле, и в тексте комментария,
 * который видят все, ему не место.
 */
export function cleanComment(raw: unknown): { text: string; passcode: string } {
  let text = clean(raw).replace(/\r/g, "");
  let passcode = "";
  text = text.replace(/(?:_{5,}\s*\n\s*)?Пароль:[ \t]*\n?([^‾]{0,200}?)\s*‾{5,}/g, (_m, p: string) => {
    if (!passcode) passcode = p.replace(/\s+/g, " ").trim();
    return "\n";
  });
  // Бывает и без рамки снизу: «Пароль:» и значение следующей строкой.
  text = text.replace(/(?:_{5,}\s*\n\s*)?Пароль:[ \t]*(?:\n[ \t]*([^\n]{0,60}))?/g, (_m, p?: string) => {
    if (!passcode && p) passcode = p.trim();
    return "\n";
  });
  if (/^(-+|нет|без пароля|0)$/i.test(passcode)) passcode = "";
  text = text.replace(/[+-]={5,}[+-]?[\s\S]*?_{5,}/g, "\n");
  text = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[_‾=+\-"]{2,}$/.test(l) && !/^\d{1,2}[.-]\d{1,2}[.-]\d{4}( \d{1,2}[:.-]\d{2})?$/.test(l))
    .join("\n");
  return { text: text.slice(0, 4000), passcode: passcode.slice(0, 100) };
}

// ------------------------------------------------------------------ шапки

const CUSTOMER_HEAD = ["Номер", "Тип", "Имя", "Телефон", "Ещё телефон", "Адрес", "Источник", "Примечание", "Техника"];
const STOCK_HEAD = ["Наименование", "Категория", "Единица", "Остаток", "Себестоимость, ₽", "Склад"];
const ORDER_HEAD = [
  "Номер", "Принят", "Статус", "Тип обращения", "Клиент", "Номер клиента", "Телефон клиента",
  "Техника", "Бренд", "Модель", "Серийный номер", "Неисправность", "Комплектность", "Внешнее состояние",
  "Примечание приёмщика", "Диагноз", "Мастер", "Завершён", "Выдан",
  "Работы, ₽", "Состав работ", "Запчасти, ₽", "Состав запчастей", "Скидка, ₽", "Итого, ₽", "Гарантия до",
];

const table = (head: string[], rows: Array<Array<string | number>>): TableRow[] => [
  { n: 1, cells: head },
  ...rows.map((cells, i) => ({ n: i + 2, cells: cells.map((c) => (c === "" ? null : c)) })),
];

// ------------------------------------------------------------------ разбор

function convert(tables: Record<string, SqlTable>): Converted {
  const notes: string[] = [];
  const catalog = tables.Catalog?.rows ?? [];
  const clients = tables.ClientsMap?.rows ?? [];
  const stockRows = tables.Stock?.rows ?? [];
  const stockMap = tables.StockMap?.rows ?? [];
  const states = tables.StatesMap?.rows ?? [];

  const live = catalog.filter((o) => !flag(o.Deleted));
  const deleted = catalog.length - live.length;
  if (deleted) notes.push(`Заказы, удалённые в старой программе, не переносятся: ${deleted}.`);

  // ------------------------------------------------------------- клиенты
  // Техника клиента собирается из его заказов: отдельной таблицы техники
  // в старой программе нет, а в карточке клиента она нужна.
  const devicesOf = new Map<string, string[]>();
  for (const o of live) {
    const id = trim(o.ClientId);
    const what = [clean(o.WhatRemont).toLowerCase(), asIs(o.brand), asIs(o.model)].filter(Boolean).join(" ");
    if (!id || !what) continue;
    const serial = serialOf(o.SerialNumber);
    const line = (serial ? `${what} (${serial})` : what).replace(/;/g, ",");
    const had = devicesOf.get(id) ?? [];
    if (!had.includes(line)) had.push(line);
    devicesOf.set(id, had);
  }

  const customerRows: Array<Array<string | number>> = [];
  const nameById = new Map<string, string>();
  const phoneById = new Map<string, string>();
  const rowByPhone = new Map<string, number>();
  let merged = 0;
  let noPhone = 0;

  for (const c of clients) {
    const id = trim(c.id);
    const [main = "", second = ""] = phones(c.Phone);
    const name = caps(c.FIO) || `Клиент №${id}`;
    nameById.set(id, name);
    if (main) phoneById.set(id, main);
    else noPhone += 1;

    const devices = devicesOf.get(id) ?? [];

    // Один номер — одна карточка: в старой базе один и тот же человек заведён
    // по нескольку раз. Склеиваем сами — с техникой из обеих карточек, — а
    // заказы второй карточки найдут первую по телефону.
    const twin = main ? rowByPhone.get(main) : undefined;
    if (twin !== undefined) {
      merged += 1;
      const have = String(customerRows[twin][8] || "").split("; ").filter(Boolean);
      for (const d of devices) if (!have.includes(d)) have.push(d);
      customerRows[twin][8] = have.slice(0, 20).join("; ");
      continue;
    }
    if (main) rowByPhone.set(main, customerRows.length);

    const note = [clean(c.Primechanie)];
    // Мусор в поле телефона («…0441Максим») не выбрасываем молча.
    const rawPhone = clean(c.Phone);
    if (rawPhone && phones(rawPhone).length === 0) note.push(`Телефон в старой программе: ${rawPhone}`);
    if (flag(c.Blist)) note.push("Был в чёрном списке старой программы");

    customerRows.push([
      id,
      "Физлицо",
      name,
      main,
      second,
      clean(c.Adress),
      clean(c.aboutUs),
      note.filter(Boolean).join(". "),
      devices.slice(0, 20).join("; "),
    ]);
  }
  if (merged) notes.push(`Клиенты с одним и тем же телефоном склеены в одну карточку: ${merged}.`);
  if (noPhone) notes.push(`Клиенты без годного телефона переносятся по номеру: ${noPhone}.`);
  const blacklisted = new Set(clients.filter((c) => flag(c.Blist)).map((c) => trim(c.id)));

  // --------------------------------------------------------------- склад
  const stockById = new Map<string, string>();
  const stockOut: Array<Array<string | number>> = [];
  for (const s of stockRows) {
    const name = sentence(s.Naimenovanie);
    if (!name) continue;
    stockById.set(trim(s.id), name);
    stockOut.push([name, sentence(s.Kategoriya), "шт", Math.max(0, num(s.CountOf)), num(s.Price), "Основной склад"]);
  }

  // Запчасти со склада, списанные в заказ, — по номеру заказа.
  const partsOf = new Map<string, string[]>();
  for (const m of stockMap) {
    const order = trim(m.clientId);
    const name = stockById.get(trim(m.ZIPId));
    if (!order || !name) continue;
    const qty = num(m.countOfZIP) || 1;
    const price = num(m.priceOfZIP);
    const line = `${lineName(name)}${qty === 1 ? "" : ` ×${qty}`} — ${price}`;
    partsOf.set(order, [...(partsOf.get(order) ?? []), line]);
  }

  // ------------------------------------------------------ история статусов
  // Колонки в таблице перепутаны самой программой: в State лежит дата, в
  // date — текст события. Берём только смену статуса; «Сообщение
  // отправлено» — это СМС, нам его переносить некуда.
  const history: MigrationHistory[] = [];
  const readyAt = new Map<string, Date>();
  for (const s of states) {
    const text = trim(s.date);
    const m = text.match(/^Установлен статус\s*([\s\S]+)$/i);
    if (!m) continue;
    const status = STATUS[m[1].trim().toLowerCase()];
    const at = toDate(s.State);
    const number = trim(s.clientId);
    if (!status || !at || !number) continue;
    history.push({ number, status, at });
    if (status === "Готов") readyAt.set(number, at);
  }

  // ------------------------------------------------------ мастера
  const staffBy = new Map<string, MigrationStaff>();

  // Пункт приёма («адрес СЦ»): самый частый — это сама мастерская, про неё
  // писать нечего. Остальные — другие точки или мастерские-партнёры, и это
  // стоит сохранить в заказе.
  const bySc = new Map<string, number>();
  for (const o of live) bySc.set(clean(o.AdressSC), (bySc.get(clean(o.AdressSC)) ?? 0) + 1);
  const ownSc = [...bySc.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

  // --------------------------------------------------------------- заказы
  const orderRows: Array<Array<string | number>> = [];
  const payments: MigrationPayment[] = [];
  const prepayments = new Map<string, number>();
  const passcodes = new Map<string, string>();
  const estimates = new Map<string, number>();
  const unknownStatus = new Map<string, number>();
  let lastNumber: number | null = null;
  let noClient = 0;

  const sorted = [...live].sort((a, b) => Number(trim(a.id)) - Number(trim(b.id)));
  for (const o of sorted) {
    const number = trim(o.id);
    const cid = trim(o.ClientId);
    if (!cid && !clean(o.surname) && !clean(o.phone)) {
      noClient += 1;
      continue;
    }
    if (/^\d+$/.test(number)) lastNumber = Math.max(lastNumber ?? 0, Number(number));

    const raw = clean(o.Status_remonta).toLowerCase();
    const status = STATUS[raw] ?? "";
    if (raw && !status) unknownStatus.set(raw, (unknownStatus.get(raw) ?? 0) + 1);

    const accepted = toDate(o.Data_priema);
    const issued = status === "Выдан" ? (toDate(o.Data_vidachi) ?? accepted) : null;

    // Деньги. «Затраты» — это то, во что мастерской обошлись запчасти;
    // работа отдельной строкой нигде не считалась, поэтому она — остаток.
    // «Окончательная стоимость» — сумма, которую взяли с клиента, уже со
    // скидкой: у нас итог = работы + запчасти − скидка, отсюда и работа.
    const total = Math.max(0, num(o.okonchatelnaya_stoimost_remonta));
    const discount = Math.max(0, num(o.Skidka));
    const parts = Math.min(Math.max(0, num(o.Zatrati)), total + discount);
    const work = Math.max(0, total + discount - parts);
    const prepaid = Math.max(0, num(o.Predoplata));

    const works = lineName(o.vipolnenie_raboti);
    const workLine = work > 0 || works ? `${works || "Ремонт"} — ${work}` : "";
    const partLines = partsOf.get(number) ?? [];
    const partLine = partLines.length ? partLines.join("; ") : parts > 0 ? `Запчасти — ${parts}` : "";

    const days = warrantyDays(o.Garanty);
    const master = masterOf(o.master);
    if (master.name) {
      const s = staffBy.get(master.name) ?? { name: master.name, local: latin(master.name), orders: 0, lastAt: null };
      s.orders += 1;
      if (accepted && (!s.lastAt || accepted > s.lastAt)) s.lastAt = accepted;
      staffBy.set(master.name, s);
    }

    if (num(o.predvaritelnaya_stoimost) > 0) estimates.set(number, num(o.predvaritelnaya_stoimost));
    const comment = cleanComment(o.kommentarij);
    if (comment.passcode) passcodes.set(number, comment.passcode);
    const sc = clean(o.AdressSC);
    const colour = caps(o.DeviceColour);
    const receptionNote = [
      colour && `Цвет: ${colour}`,
      sc && sc !== ownSc && `Адрес СЦ: ${sc}`,
      master.all && master.all !== master.name && `Мастера: ${master.all}`,
      clean(o.wait_zakaz) && `Запчасть: ${clean(o.wait_zakaz).toLowerCase()}`,
    ]
      .filter(Boolean)
      .join("\n");

    const cidName = nameById.get(cid) ?? (caps(o.surname) || `Клиент №${cid} (из старой базы)`);
    const tel = phoneById.get(cid) ?? phones(o.phone)[0] ?? "";

    orderRows.push([
      number,
      ru(accepted),
      status,
      raw === "принят по гарантии" ? "Гарантийный возврат" : "Ремонт",
      cidName,
      cid,
      tel,
      clean(o.WhatRemont).toLowerCase(),
      asIs(o.brand),
      asIs(o.model),
      serialOf(o.SerialNumber),
      lineName(o.polomka).replace(/\/+$/, "") || "не указана",
      list(o.komplektonst),
      list(o.sostoyanie),
      receptionNote,
      comment.text,
      master.name,
      ru(readyAt.get(number) ?? (issued ? issued : null)),
      ru(issued),
      work,
      workLine,
      parts,
      partLine,
      discount,
      total,
      issued && days ? ru(plusDays(issued, days)) : "",
    ]);

    // Оплата. Долгов в старой программе нет: выдан — значит рассчитались.
    // Предоплата — отдельным платежом со своей датой, остальное — в день выдачи.
    if (prepaid > 0) {
      prepayments.set(number, prepaid);
      const at = toDate(o.Data_predoplaty) ?? accepted;
      if (at) {
        const amount = issued ? Math.min(prepaid, total) : prepaid;
        if (amount > 0) payments.push({ number, amount, at, comment: "Предоплата (старая программа)" });
      }
    }
    if (issued && total > 0) {
      const rest = total - (prepaid > 0 ? Math.min(prepaid, total) : 0);
      if (rest > 0) payments.push({ number, amount: rest, at: issued, comment: "Оплата при выдаче (старая программа)" });
    }
  }

  if (noClient) notes.push(`Заказы без клиента не переносятся: ${noClient}.`);
  if (unknownStatus.size) {
    notes.push(
      "Статусы, которых нет у нас, — такие заказы встанут на начальный статус: " +
        [...unknownStatus].map(([s, n]) => `«${s}» (${n})`).join(", ") + "."
    );
  }
  if (blacklisted.size) notes.push(`Клиенты из чёрного списка помечены красным: ${blacklisted.size}.`);

  // Клиенты с сотнями заказов — это обычно мастерские-партнёры, а не ошибка.
  // Сказать стоит: иначе «клиент с шестью сотнями ремонтов» удивит.
  const perClient = new Map<string, number>();
  for (const r of orderRows) perClient.set(String(r[5]), (perClient.get(String(r[5])) ?? 0) + 1);
  const heavy = [...perClient].filter(([, n]) => n >= 50).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (heavy.length) {
    notes.push(
      "Клиенты с большим числом заказов — похоже, мастерские-партнёры: " +
        heavy.map(([id, n]) => `${nameById.get(id) ?? `№${id}`} (${n})`).join(", ") + "."
    );
  }

  const staff = [...staffBy.values()].sort((a, b) => b.orders - a.orders);

  return {
    source: { id: SOURCE.id, title: SOURCE.title },
    staff,
    customers: table(CUSTOMER_HEAD, customerRows),
    stock: table(STOCK_HEAD, stockOut),
    orders: table(ORDER_HEAD, orderRows),
    payments,
    prepayments,
    passcodes,
    estimates,
    history,
    lastNumber,
    notes,
    colors: new Map([...blacklisted].map((id) => [id, "red"])),
  };
}

/** «Б/Н», «NN», «нет» — это «серийника нет», а не серийный номер. */
function serialOf(v: unknown): string {
  const s = asIs(v);
  return /^(б\s*[\\/]?\s*н|nn|n\/a|нет|-+|0+)$/i.test(s) ? "" : s;
}

export const SOURCE: MigrationSource = {
  id: "catalog-clientsmap",
  title: "Старая программа учёта ремонтов (baza.sqlite)",
  detect: (t) => !!t.Catalog && !!t.ClientsMap && t.Catalog.columns.includes("Status_remonta"),
  convert,
};
