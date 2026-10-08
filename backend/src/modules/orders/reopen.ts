/**
 * Возврат выданного заказа в работу и «Акт доплаты».
 *
 * Бывает: клиент забрал технику, вспомнил, что забыл сказать о второй
 * неисправности, и вернулся в тот же день. Новый заказ на это заводить
 * неудобно — та же техника, тот же ремонт. Поэтому выданный заказ можно
 * «Вернуть в работу»: выдача снимается, а снимок того, что было на момент
 * первой выдачи (работы, запчасти, итог), ложится в `Order.reopens`.
 * При повторной выдаче то, что добавили сверх снимка, печатается «Актом
 * доплаты» — с номером и датой первой выдачи и суммой к доплате.
 *
 * Деньги считаются как обычно: касса и долг смотрят на итог заказа и
 * проведённые оплаты, снимок им не нужен.
 */

export type ReopenLine = { name: string; qty: number; price: number };

export type Reopen = {
  /** Когда вернули в работу. */
  at: string;
  byId: string | null;
  reason: string;
  /** Когда заказ был выдан до возврата. */
  issuedAt: string;
  /** Итог заказа на момент той выдачи. */
  total: number;
  works: ReopenLine[];
  parts: ReopenLine[];
};

const line = (v: unknown): ReopenLine | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  const qty = Number(o.qty);
  const price = Number(o.price);
  if (!name || !Number.isFinite(qty) || !Number.isFinite(price)) return null;
  return { name, qty, price };
};

/** Что лежит в базе — разбираем бережно: испорченная запись не должна ронять карточку заказа. */
export function parseReopens(raw: unknown): Reopen[] {
  if (!Array.isArray(raw)) return [];
  const out: Reopen[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.at !== "string" || typeof o.issuedAt !== "string") continue;
    out.push({
      at: o.at,
      byId: typeof o.byId === "string" ? o.byId : null,
      reason: typeof o.reason === "string" ? o.reason : "",
      issuedAt: o.issuedAt,
      total: Number.isFinite(Number(o.total)) ? Number(o.total) : 0,
      works: Array.isArray(o.works) ? (o.works.map(line).filter(Boolean) as ReopenLine[]) : [],
      parts: Array.isArray(o.parts) ? (o.parts.map(line).filter(Boolean) as ReopenLine[]) : [],
    });
  }
  return out;
}

const keyOf = (l: ReopenLine) => `${l.name.trim().replace(/\s+/g, " ").toLowerCase()}|${l.price}`;

/**
 * Строки, добавленные после возврата. Сравниваем по названию и цене; если
 * у той же строки выросло количество — в акт идёт только прибавка. Убранное
 * и подешевевшее в акт доплаты не попадает — доплачивать за него нечего.
 */
export function addedLines(now: ReopenLine[], before: ReopenLine[]): ReopenLine[] {
  const had = new Map<string, number>();
  for (const l of before) had.set(keyOf(l), (had.get(keyOf(l)) ?? 0) + l.qty);
  const out: ReopenLine[] = [];
  for (const l of now) {
    const k = keyOf(l);
    const left = had.get(k) ?? 0;
    const extra = Math.round((l.qty - left) * 1000) / 1000;
    had.set(k, Math.max(0, left - l.qty));
    if (extra > 0) out.push({ name: l.name, qty: extra, price: l.price });
  }
  return out;
}

const plain = (rows: Array<{ name: string; qty: unknown; price: unknown }>): ReopenLine[] =>
  rows.map((r) => ({ name: r.name, qty: Number(r.qty), price: Number(r.price) }));

/** Снимок заказа на момент возврата в работу. */
export function snapshot(
  order: {
    issuedAt: Date;
    total: unknown;
    works: Array<{ name: string; qty: unknown; price: unknown }>;
    parts: Array<{ name: string; qty: unknown; price: unknown }>;
  },
  by: { at: Date; byId: string | null; reason: string }
): Reopen {
  return {
    at: by.at.toISOString(),
    byId: by.byId,
    reason: by.reason,
    issuedAt: order.issuedAt.toISOString(),
    total: Number(order.total),
    works: plain(order.works),
    parts: plain(order.parts),
  };
}

/**
 * Что показать в карточке и на «Акте доплаты»: последний возврат и то, что
 * добавили после него. Суммы — только тем, кто видит деньги.
 */
export function extraOf(
  order: {
    reopens: unknown;
    total: unknown;
    works: Array<{ name: string; qty: unknown; price: unknown }>;
    parts: Array<{ name: string; qty: unknown; price: unknown }>;
  },
  money: boolean
) {
  const list = parseReopens(order.reopens);
  const last = list[list.length - 1];
  if (!last) return null;
  const works = addedLines(plain(order.works), last.works);
  const parts = addedLines(plain(order.parts), last.parts);
  const amount = Math.round((Number(order.total) - last.total) * 100) / 100;
  return {
    times: list.length,
    reopenedAt: last.at,
    reason: last.reason,
    prevIssuedAt: last.issuedAt,
    works,
    parts,
    ...(money ? { totalBefore: last.total, amount } : {}),
  };
}
