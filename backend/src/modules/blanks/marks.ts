/**
 * Метки своих бланков из Excel (03.11.2026).
 *
 * Мастерская рисует бланк в Excel как хочет и ставит в ячейки метки в фигурных
 * скобках: «{номер}», «{клиент}». Строка таблицы с метками списка («{работа}»,
 * «{работа цена}») размножается на столько строк, сколько работ в заказе.
 *
 * Метку пишут как удобно: регистр, «ё» и лишние пробелы не важны.
 */

export type Target = "order" | "sale";

export interface MarkDef {
  key: string;
  hint: string;
  /** Деньги: в ячейке из одной метки — число с форматом «4 700 ₽», чтобы работали формулы. */
  money?: boolean;
}

/** Список: строка шаблона повторяется для каждого элемента. */
export interface ListDef {
  /** Главная метка списка — по ней узнаём строку. */
  key: string;
  title: string;
  fields: MarkDef[];
}

export const ORDER_MARKS: MarkDef[] = [
  { key: "номер", hint: "номер заказа: Р-2026-00123" },
  { key: "дата", hint: "сегодня: 03.11.2026" },
  { key: "дата приёма", hint: "когда приняли технику" },
  { key: "дата готовности", hint: "когда ремонт завершён" },
  { key: "дата выдачи", hint: "когда выдали клиенту" },
  { key: "срок", hint: "срок готовности" },
  { key: "статус", hint: "статус заказа" },
  { key: "клиент", hint: "имя или название клиента" },
  { key: "телефон", hint: "основной телефон" },
  { key: "телефон 2", hint: "второй телефон" },
  { key: "почта", hint: "email клиента" },
  { key: "адрес", hint: "адрес клиента" },
  { key: "номер аутсорса", hint: "номер в базе заказчика" },
  { key: "устройство", hint: "Ноутбук ASUS X550" },
  { key: "тип техники", hint: "Ноутбук" },
  { key: "бренд", hint: "ASUS" },
  { key: "модель", hint: "X550" },
  { key: "серийный", hint: "серийный номер" },
  { key: "пароль", hint: "пароль устройства" },
  { key: "комплектность", hint: "через запятую" },
  { key: "состояние", hint: "внешнее состояние через запятую" },
  { key: "неисправность", hint: "со слов клиента" },
  { key: "диагноз", hint: "что оказалось" },
  { key: "рекомендации", hint: "рекомендации мастера" },
  { key: "мастер", hint: "мастер заказа" },
  { key: "принял", hint: "кто принял технику" },
  { key: "выдал", hint: "кто выдал клиенту" },
  { key: "работы итого", hint: "сумма работ", money: true },
  { key: "запчасти итого", hint: "сумма запчастей", money: true },
  { key: "скидка", hint: "скидка рублями", money: true },
  { key: "итого", hint: "итог заказа", money: true },
  { key: "итого прописью", hint: "Четыре тысячи семьсот рублей 00 копеек" },
  { key: "предоплата", hint: "внесено при приёме", money: true },
  { key: "оплачено", hint: "проведено в кассу по заказу", money: true },
  { key: "к оплате", hint: "осталось заплатить", money: true },
  { key: "оплата", hint: "наличный / безналичный расчёт" },
  { key: "гарантия", hint: "дней гарантии" },
  { key: "гарантия до", hint: "дата окончания гарантии" },
  { key: "мастерская", hint: "название с бланков" },
  { key: "реквизиты", hint: "реквизиты с бланков" },
];

export const ORDER_LISTS: ListDef[] = [
  {
    key: "работа",
    title: "Работы",
    fields: [
      { key: "работа", hint: "название работы" },
      { key: "работа кол-во", hint: "количество" },
      { key: "работа цена", hint: "цена", money: true },
      { key: "работа сумма", hint: "кол-во × цена", money: true },
      { key: "работа гарантия", hint: "гарантия на работу, дней" },
    ],
  },
  {
    key: "запчасть",
    title: "Запчасти",
    fields: [
      { key: "запчасть", hint: "название" },
      { key: "запчасть кол-во", hint: "количество" },
      { key: "запчасть цена", hint: "цена", money: true },
      { key: "запчасть сумма", hint: "кол-во × цена", money: true },
    ],
  },
  {
    key: "строка",
    title: "Работы и запчасти одним списком",
    fields: [
      { key: "строка", hint: "сначала работы, потом запчасти" },
      { key: "строка кол-во", hint: "количество" },
      { key: "строка цена", hint: "цена", money: true },
      { key: "строка сумма", hint: "кол-во × цена", money: true },
    ],
  },
];

export const SALE_MARKS: MarkDef[] = [
  { key: "номер", hint: "номер продажи: П-2026-00012" },
  { key: "дата", hint: "дата продажи" },
  { key: "клиент", hint: "покупатель, если выбран" },
  { key: "телефон", hint: "телефон покупателя" },
  { key: "продавец", hint: "кто продал" },
  { key: "сумма без скидки", hint: "до скидки", money: true },
  { key: "скидка", hint: "скидка рублями", money: true },
  { key: "итого", hint: "к оплате", money: true },
  { key: "итого прописью", hint: "Четыре тысячи семьсот рублей 00 копеек" },
  { key: "оплата", hint: "наличный / безналичный расчёт" },
  { key: "гарантия", hint: "дней гарантии" },
  { key: "гарантия до", hint: "дата окончания гарантии" },
  { key: "примечание", hint: "примечание к продаже" },
  { key: "мастерская", hint: "название с бланков" },
  { key: "реквизиты", hint: "реквизиты с бланков" },
];

export const SALE_LISTS: ListDef[] = [
  {
    key: "товар",
    title: "Товары",
    fields: [
      { key: "товар", hint: "название" },
      { key: "товар артикул", hint: "артикул" },
      { key: "товар кол-во", hint: "количество" },
      { key: "товар цена", hint: "цена", money: true },
      { key: "товар сумма", hint: "кол-во × цена", money: true },
    ],
  },
];

/** «{№}» — номер строки в списке, в любой строке-списке. */
export const ROW_NO = "№";

export const marksOf = (t: Target) => (t === "sale" ? SALE_MARKS : ORDER_MARKS);
export const listsOf = (t: Target) => (t === "sale" ? SALE_LISTS : ORDER_LISTS);

/** Метка как её сравниваем: без регистра, «ё» → «е», пробелы — одиночные. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s ]+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .trim();

export const MARK_RE = /\{([^{}\n]{1,40})\}/g;

export interface Known {
  scalar: Map<string, MarkDef>;
  list: Map<string, { list: ListDef; field: MarkDef }>;
}

export function knownOf(t: Target): Known {
  const scalar = new Map(marksOf(t).map((m) => [norm(m.key), m]));
  const list = new Map<string, { list: ListDef; field: MarkDef }>();
  for (const l of listsOf(t)) for (const f of l.fields) list.set(norm(f.key), { list: l, field: f });
  return { scalar, list };
}

/** Небольшая опечатка: «{телефн}» → «{телефон}». Расстояние Левенштейна до 2. */
export function suggest(raw: string, t: Target): string | null {
  const k = norm(raw);
  const all = [...marksOf(t).map((m) => m.key), ...listsOf(t).flatMap((l) => l.fields.map((f) => f.key)), ROW_NO];
  let best: { key: string; d: number } | null = null;
  for (const key of all) {
    const d = lev(k, norm(key));
    if (d <= 2 && (!best || d < best.d)) best = { key, d };
  }
  return best?.key ?? null;
}

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
