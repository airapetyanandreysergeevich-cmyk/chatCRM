import { withPlatform, withTenant } from "../../lib/db";
import { notifyTenant } from "../../lib/notify";
import type { PayoutNote } from "../../lib/payment";

/**
 * Деньги клиента сразу сотруднику (03.11.2026) — оповещения.
 *
 *   оплата своим способом на Олега → Олегу 💵 + колокольчик + push
 *      ├ «Принять»     → тому, кто принял оплату: «Олег подтвердил»
 *      └ «Не получал»  → тому, кто принял, и владельцу/управляющему
 *   сутки без ответа → напоминание Олегу и владельцу (один раз)
 *
 * Вызывать после транзакции с оплатой (правило notify.ts).
 */

const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU").replace(/[  ]/g, " ")} ₽`;

async function nameOf(tenantId: string, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  return withTenant(tenantId, (tx) => tx.user.findFirst({ where: { id: userId }, select: { fullName: true } }))
    .then((u) => u?.fullName ?? null)
    .catch(() => null);
}

/** Получателю — «зачислено на ваш счёт», если он не принимал деньги сам. */
export async function notifyPayouts(tenantId: string, payouts: PayoutNote[]): Promise<void> {
  for (const p of payouts) {
    if (p.confirmed) continue;
    const taker = await nameOf(tenantId, p.takenById);
    const what = p.orderNumber ? `заказ ${p.orderNumber}` : p.saleId ? "продажа со склада" : "оплата";
    void notifyTenant(tenantId, {
      event: "money.received",
      title: `💵 Зачислено на ваш счёт: ${rub(p.amount)}`,
      body: `${p.label} · ${what}${taker ? ` · принял(а) ${taker}` : ""}. Подтвердите получение.`,
      url: "/salary?incoming=1",
      targetUserId: p.userId,
      targetWhy: "деньги клиента приняли на вас",
      payload: { payoutId: p.id, orderId: p.orderId },
    });
  }
}

/** Получатель ответил: тому, кто принимал оплату (и при «не получал» — ролям). */
export async function notifyAnswer(
  tenantId: string,
  p: { id: string; userId: string; takenById: string | null; amount: number; orderId: string | null; orderNumber: string | null },
  confirmed: boolean
): Promise<void> {
  const who = (await nameOf(tenantId, p.userId)) ?? "Сотрудник";
  const what = p.orderNumber ? ` по заказу ${p.orderNumber}` : "";
  await notifyTenant(tenantId, {
    event: confirmed ? "money.confirmed" : "money.disputed",
    title: confirmed ? `✅ ${who} подтвердил(а) ${rub(p.amount)}${what}` : `⚠ ${who} не получил(а) ${rub(p.amount)}${what}`,
    body: confirmed ? "Деньги клиента дошли до сотрудника." : "Разберитесь: в зарплате эта сумма не считается полученной, пока её не отметят.",
    url: p.orderId ? `/orders/${p.orderId}` : "/salary",
    targetUserId: p.takenById && p.takenById !== p.userId ? p.takenById : null,
    targetWhy: "вы принимали эту оплату у клиента",
    exceptUserId: p.userId,
    payload: { payoutId: p.id, orderId: p.orderId },
  });
}

/** Колокольчик «зачислено» гаснет, когда получатель ответил. */
export async function markPayoutRead(tenantId: string, payoutId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.notification.updateMany({
      where: { type: { in: ["money.received", "money.waiting"] }, readAt: null, payload: { path: ["payoutId"], equals: payoutId } },
      data: { readAt: new Date() },
    })
  ).catch(() => undefined);
}

const DAY = 24 * 3600_000;

/** Раз в час: неподтверждённые дольше суток — напоминание (один раз по каждой). */
export async function remindPendingPayouts(now = new Date()): Promise<number> {
  try {
    const due = await withPlatform((tx) =>
      tx.salaryPayout.findMany({
        where: { deletedAt: null, status: "PENDING", remindedAt: null, createdAt: { lt: new Date(now.getTime() - DAY) } },
        select: { id: true, tenantId: true, userId: true, amount: true, orderId: true, comment: true },
        take: 500,
      })
    );
    for (const p of due) {
      await withPlatform((tx) => tx.salaryPayout.update({ where: { id: p.id }, data: { remindedAt: now } }));
      const who = (await nameOf(p.tenantId, p.userId)) ?? "Сотрудник";
      await notifyTenant(p.tenantId, {
        event: "money.waiting",
        title: `⏳ Не подтверждено сутки: ${rub(Number(p.amount))} — ${who}`,
        body: `${p.comment ?? "Деньги клиента"}. Получатель ещё не нажал «Принять».`,
        url: "/salary?incoming=1",
        targetUserId: p.userId,
        targetWhy: "деньги клиента приняли на вас",
        payload: { payoutId: p.id, orderId: p.orderId },
      });
    }
    return due.length;
  } catch (err) {
    console.error("[money] напоминания:", (err as Error).message);
    return 0;
  }
}

export function startPayoutReminders(): void {
  const t = setInterval(() => void remindPendingPayouts(), 3600_000);
  t.unref?.();
  setTimeout(() => void remindPendingPayouts(), 60_000).unref?.();
}
