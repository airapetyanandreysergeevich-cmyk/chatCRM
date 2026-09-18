import type { Prisma } from "@prisma/client";

/**
 * Номер клиента выдаётся счётчиком самой мастерской — как и номер заказа.
 *
 * Зачем клиенту номер, если есть телефон. Телефон опознаёт человека ровно до
 * тех пор, пока он настоящий: при переносе из другой программы половина
 * карточек приезжает с выдуманным номером, с одним на всю мастерскую
 * дежурным или вовсе без него. Номер же не зависит ни от чего: по нему
 * повторная загрузка того же файла обновляет карточки, а не заводит вторые.
 *
 * Счётчик двигается одним `UPDATE ... RETURNING`, поэтому два приёмщика,
 * заводящие клиента одновременно, не получат один номер. Такой же приём, как
 * в `orderNumber.ts`, и по той же причине: `SELECT MAX(...) + 1` гонку
 * проигрывает — и проигрывает молча, а разгребать это потом приходится
 * руками в живой базе.
 */
export async function nextCustomerNumber(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ customerNumberNext: number }>>`
    UPDATE "Tenant"
       SET "customerNumberNext" = "customerNumberNext" + 1
     WHERE id = ${tenantId}
    RETURNING "customerNumberNext"
  `;
  if (!rows.length) throw new Error("Мастерская не найдена");
  return Number(rows[0].customerNumberNext) - 1;
}

/**
 * Номер для клиента, приехавшего из чужой программы со своим номером.
 *
 * Чужой номер сохраняем как есть — в этом весь смысл: следующая загрузка
 * того же файла узнает карточку. Но счётчик мастерской после этого обязан
 * встать за ним, иначе первый же клиент, заведённый руками, налетит на
 * занятый номер и упадёт на уникальном индексе.
 */
export async function reserveCustomerNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  wanted: number
): Promise<number> {
  await tx.$executeRaw`
    UPDATE "Tenant"
       SET "customerNumberNext" = GREATEST("customerNumberNext", ${wanted} + 1)
     WHERE id = ${tenantId}
  `;
  return wanted;
}
