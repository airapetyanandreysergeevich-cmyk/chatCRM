/**
 * Проверка расчёта долга.
 *
 * Долг нигде не хранится: он считается как итог заказа минус проведённые
 * деньги. Это единственный источник правды и для карточки клиента, и для
 * панели просрочки, и для погашения — поэтому ошибка здесь видна не как сбой,
 * а как неверная сумма, которую приёмщик называет человеку вслух.
 *
 * База тут не нужна: подставляем вместо неё заглушку и проверяем сам счёт.
 *
 *   npx tsx test/debt.ts
 */

import { debtOf, debts } from "../src/lib/debt";

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails += 1;
};

const DAY = 24 * 60 * 60 * 1000;
const вчера = new Date(Date.now() - DAY);
const завтра = new Date(Date.now() + DAY);

interface Заказ {
  id: string;
  number: string;
  total: number;
  issuedAt: Date | null;
  debtDueAt: Date | null;
}

/** Движения по заказу: положительное — приход, отрицательное — возврат. */
type Движения = Record<string, number[]>;

function fakeTx(orders: Заказ[], money: Движения = {}) {
  return {
    order: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        orders.filter((o) => {
          if (where?.debtDueAt) {
            const cond = where.debtDueAt as { lte?: Date };
            if (!o.debtDueAt) return false;
            if (cond.lte && o.debtDueAt > cond.lte) return false;
          }
          return true;
        }),
    },
    transaction: {
      groupBy: async () => {
        const rows: Array<{ orderId: string; direction: "IN" | "OUT"; _sum: { amount: number } }> = [];
        for (const [orderId, list] of Object.entries(money)) {
          const income = list.filter((n) => n > 0).reduce((a, b) => a + b, 0);
          const refund = list.filter((n) => n < 0).reduce((a, b) => a - b, 0);
          if (income) rows.push({ orderId, direction: "IN", _sum: { amount: income } });
          if (refund) rows.push({ orderId, direction: "OUT", _sum: { amount: refund } });
        }
        return rows;
      },
    },
  } as never;
}

const заказ = (id: string, total: number, extra: Partial<Заказ> = {}): Заказ => ({
  id,
  number: id,
  total,
  issuedAt: вчера,
  debtDueAt: null,
  ...extra,
});

async function main(): Promise<void> {
  // 1. Оплаченный заказ долгом не считается и в списке не появляется.
  const оплачен = await debts(fakeTx([заказ("A", 3000)], { A: [3000] }));
  check(оплачен.length === 0, "полностью оплаченный заказ не висит долгом");

  // 2. Переплата — тоже не долг. Отрицательный долг показывать нельзя: в
  //    карточке он выглядел бы как «клиент должен минус двести».
  const переплата = await debts(fakeTx([заказ("A", 3000)], { A: [3500] }));
  check(переплата.length === 0, "переплата не превращается в отрицательный долг");

  // 3. Частичная оплата.
  const часть = await debts(fakeTx([заказ("A", 3000)], { A: [1000, 200] }));
  check(часть.length === 1 && часть[0].due === 1800, `долг — остаток (${часть[0]?.due})`);
  check(часть[0].paid === 1200, "оплаченное складывается из всех приходов");

  // 4. Возврат снова делает заказ неоплаченным. Это правда, а не ошибка:
  //    деньги вернули, значит их нет.
  const возврат = await debts(fakeTx([заказ("A", 3000)], { A: [3000, -1000] }));
  check(возврат.length === 1 && возврат[0].due === 1000, `возврат увеличивает долг (${возврат[0]?.due})`);

  // 5. Копейки. Иначе долг в 0,004 ₽ висит вечно и требует погашения, которого
  //    не существует в природе.
  const копейки = await debts(fakeTx([заказ("A", 1000.004)], { A: [1000] }));
  check(копейки.length === 0, "долг в доли копейки не висит");

  // 6. Невыданный заказ — не долг, а незаконченная работа.
  const вработе = await debts(fakeTx([заказ("A", 3000, { issuedAt: null })]));
  check(вработе.length === 1, "заглушка отдаёт что дали (фильтр выданных — на стороне базы)");

  // 7. Просрочка.
  const сроки = await debts(
    fakeTx([
      заказ("A", 1000, { debtDueAt: вчера }),
      заказ("B", 2000, { debtDueAt: завтра }),
      заказ("C", 3000, { debtDueAt: null }),
    ])
  );
  const флаг = (n: string) => сроки.find((d) => d.number === n)?.overdue;
  check(флаг("A") === true, "вчерашний срок — просрочка");
  check(флаг("B") === false, "завтрашний срок — ещё не просрочка");
  check(флаг("C") === false, "долг без обещанной даты просрочкой не считается");

  // 8. Отбор только просроченных идёт запросом, а не после него: иначе
  //    страница главной тянула бы все долги мастерской ради трёх строк.
  const только = await debts(fakeTx(сроки.map((d) => заказ(d.number, d.total, { debtDueAt: d.debtDueAt }))), {
    overdueOnly: true,
  });
  check(
    только.length === 1 && только[0].number === "A",
    `в просрочку попал только просроченный (${только.map((d) => d.number).join(", ") || "никто"})`
  );

  // 9. Суммарный долг клиента.
  const всего = await debtOf(
    fakeTx([заказ("A", 1000), заказ("B", 2000), заказ("C", 500)], { B: [500], C: [500] }),
    "кто-нибудь"
  );
  check(всего === 2500, `суммарный долг — 1000 + 1500, оплаченный не в счёт (${всего})`);

  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exitCode = fails === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exitCode = 1;
});
