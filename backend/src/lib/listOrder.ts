import { z } from "zod";

/**
 * Порядок строк в списках: общие кусочки для клиентов, заказов и склада.
 *
 * Сортирует сервер, а не страница. Списки отдаются по пятьдесят строк, и
 * «сначала красные», отсортированное в браузере, нашло бы красных только
 * среди этих пятидесяти — а клиент с красной меткой на седьмой странице так
 * и остался бы на седьмой. Человек этого не заметит и решит, что красных
 * больше нет.
 */

/**
 * Цветные метки клиентов в том порядке, в каком их показывает палитра.
 * Этот же порядок — порядок сортировки «по цвету»: сначала красные.
 */
export const CUSTOMER_COLORS = ["red", "amber", "green", "pink", "blue", "purple"] as const;
export type CustomerColor = (typeof CUSTOMER_COLORS)[number];

const RANK = new Map<string, number>(CUSTOMER_COLORS.map((c, i) => [c, i]));

/** Место цвета в очереди. Без метки — в самом конце, после всех цветов. */
export const colorRank = (color: string | null | undefined): number =>
  (color ? RANK.get(color) : undefined) ?? CUSTOMER_COLORS.length;

/**
 * Фильтр «Метка»: один цвет или «без метки».
 *
 * Пустая строка в поле цвета — то же, что её отсутствие: карточки, приехавшие
 * из чужой программы, могли попасть в базу и так.
 */
export const colorFilterField = z.enum([...CUSTOMER_COLORS, "none"]).optional();

export function customerColorWhere(color: (typeof CUSTOMER_COLORS)[number] | "none" | undefined) {
  if (!color) return {};
  if (color === "none") return { OR: [{ color: null }, { color: "" }] };
  return { color };
}

/**
 * Сколько строк читаем разом, когда порядок нельзя поручить базе.
 *
 * «По цвету» (в порядке палитры, а не по алфавиту названий), «по сумме оплат»,
 * «по последнему визиту» — это либо своё правило сравнения, либо сумма по
 * другой таблице. Базе такое объяснять долго, а прочитать двадцать тысяч
 * коротких строк (номер, цвет, дата) — доли секунды. Двадцать тысяч — это
 * клиентская база очень большой мастерской за много лет.
 */
export const MAX_SCAN = 20_000;

/** Сравнение нескольких ключей по очереди: первый решает, следующие — при равенстве. */
export type Key = number | string | null;

export function compareKeys(a: Key[], b: Key[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    // Пустое всегда в конце — и при прямом, и при обратном порядке: заказ без
    // срока не должен оказываться «самым горящим».
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y), "ru", { numeric: true, sensitivity: "base" });
  }
  return 0;
}

/** Отсортировать по ключам и вырезать страницу — остаются только номера строк. */
export function pageIds<T extends { id: string }>(
  rows: T[],
  keyOf: (row: T) => Key[],
  q: { page: number; pageSize: number }
): string[] {
  const keyed = rows.map((r) => ({ id: r.id, key: keyOf(r) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  return keyed.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((r) => r.id);
}

/** Строки страницы, дочитанные целиком, — в том порядке, в каком их отобрали. */
export function inOrder<T extends { id: string }>(ids: string[], rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/** Обратный порядок для числа: «больше — выше». Пустое остаётся пустым. */
export const desc = (n: number | null | undefined): number | null => (n === null || n === undefined ? null : -n);

/** Дата как число для сравнения. */
export const time = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
