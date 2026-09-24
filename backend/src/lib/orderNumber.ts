import type { Prisma } from "@prisma/client";

/**
 * Номер заказа.
 *
 * Выдаётся счётчиком самой мастерской, а не сквозным по платформе: у каждой
 * своя нумерация, как в бумажном журнале. Счётчик двигается одним
 * `UPDATE ... RETURNING`, поэтому два одновременных приёма не получат один
 * номер, даже если приёмщики нажали «сохранить» разом.
 *
 * Два вида номеров:
 *
 *   - **стандартный** — Р-2026-00001: буква, год, пять цифр. Счётчик идёт
 *     без перерыва, год просто показывается;
 *   - **свой** — владелец вписывает первый номер так, как хочет его видеть:
 *     SC01, З-001, 1000. Цифры в конце — счётчик и его ширина, всё до них —
 *     приставка. С галочкой «год» номер становится SC-2026-01, и счётчик
 *     каждый январь начинается заново — ради этого год в номер и ставят.
 *
 * Год берётся по часовому поясу мастерской, а не сервера: иначе в новогоднюю
 * ночь мастерская во Владивостоке девять часов выдавала бы номера прошлого года.
 */

export interface OrderNumberFormat {
  /** Образец своего формата, как его ввели; null — стандартный. */
  template: string | null;
  prefix: string;
  width: number;
  start: number;
  withYear: boolean;
}

/** Стандартный формат — пока владелец не задал свой. */
export const STANDARD_PREFIX = "Р";
const STANDARD_WIDTH = 5;

/** Что можно писать в приставке: буквы, цифры, дефис и косая черта. */
const PREFIX_RE = /^[A-Za-zА-Яа-яЁё0-9\-/]*$/;

/**
 * Разобрать образец: SC01 → приставка SC, счётчик с 1, две цифры.
 * Возвращает либо части, либо понятную причину отказа.
 */
export function parseTemplate(
  raw: string
): { ok: true; prefix: string; start: number; width: number } | { ok: false; reason: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "Впишите первый номер" };
  if (text.length > 20) return { ok: false, reason: "Номер — не длиннее 20 знаков" };
  const m = text.match(/^(.*?)(\d+)$/);
  if (!m) return { ok: false, reason: "Номер должен заканчиваться цифрой — с неё пойдёт счёт" };
  const [, prefix, digits] = m;
  if (!PREFIX_RE.test(prefix)) return { ok: false, reason: "В начале номера — только буквы, цифры, дефис и косая черта" };
  if (digits.length > 9) return { ok: false, reason: "Счётчик — не длиннее 9 цифр" };
  return { ok: true, prefix, start: Number(digits), width: digits.length };
}

/** Номер по формату, числу счётчика и году. */
export function formatNumber(f: OrderNumberFormat, n: number, year: number): string {
  if (!f.template) return `${f.prefix}-${year}-${String(n).padStart(STANDARD_WIDTH, "0")}`;
  const body = String(n).padStart(f.width, "0");
  if (!f.withYear) return `${f.prefix}${body}`;
  // Год отделяем дефисом; если приставка уже кончается разделителем
  // («З-», «A/»), второй не добавляем.
  const lead = !f.prefix ? "" : /[-/]$/.test(f.prefix) ? f.prefix : `${f.prefix}-`;
  return `${lead}${year}-${body}`;
}

/**
 * Какое число выдаст счётчик следующим — с учётом нового года.
 * Нужно для подсказки «следующие номера», сам счётчик двигает только
 * nextOrderNumber.
 */
export function upcoming(
  f: OrderNumberFormat,
  state: { next: number; year: number | null },
  year: number,
  count = 3
): string[] {
  const from = f.template && f.withYear && state.year !== year ? f.start : state.next;
  return Array.from({ length: count }, (_, i) => formatNumber(f, from + i, year));
}

/** Год по часовому поясу мастерской — в том же виде, что и в запросе ниже. */
export async function tenantYear(tx: Prisma.TransactionClient, tenantId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ year: number }>>`
    SELECT date_part('year', now() AT TIME ZONE "timezone")::int AS year FROM "Tenant" WHERE id = ${tenantId}
  `;
  return rows[0]?.year ?? new Date().getFullYear();
}

export async function nextOrderNumber(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
  // Выражения в SET видят строку до изменения, поэтому «начать заново в новом
  // году» и «запомнить год» считаются по одному и тому же старому году.
  const rows = await tx.$queryRaw<
    Array<{
      orderNumberNext: number;
      orderNumberPrefix: string;
      orderNumberTemplate: string | null;
      orderNumberWidth: number;
      orderNumberStart: number;
      orderNumberWithYear: boolean;
      year: number;
    }>
  >`
    UPDATE "Tenant"
       SET "orderNumberNext" = CASE
             WHEN "orderNumberTemplate" IS NOT NULL AND "orderNumberWithYear"
                  AND "orderNumberYear" IS DISTINCT FROM date_part('year', now() AT TIME ZONE "timezone")::int
             THEN "orderNumberStart" + 1
             ELSE "orderNumberNext" + 1
           END,
           "orderNumberYear" = CASE
             WHEN "orderNumberTemplate" IS NOT NULL AND "orderNumberWithYear"
             THEN date_part('year', now() AT TIME ZONE "timezone")::int
             ELSE "orderNumberYear"
           END
     WHERE id = ${tenantId}
    RETURNING "orderNumberNext", "orderNumberPrefix", "orderNumberTemplate", "orderNumberWidth",
              "orderNumberStart", "orderNumberWithYear",
              date_part('year', now() AT TIME ZONE "timezone")::int AS year
  `;
  if (!rows.length) throw new Error("Мастерская не найдена");
  const r = rows[0];

  const issued = Number(r.orderNumberNext) - 1;
  return formatNumber(
    {
      template: r.orderNumberTemplate,
      prefix: r.orderNumberPrefix,
      width: Number(r.orderNumberWidth),
      start: Number(r.orderNumberStart),
      withYear: r.orderNumberWithYear,
    },
    issued,
    Number(r.year)
  );
}
