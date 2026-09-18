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

/**
 * Подтянуть счётчик выше самого большого выданного номера.
 *
 * Счётчик может отстать: номер приехал из чужой программы, карточку удалили
 * и завели заново, две загрузки шли одна за другой. Отставший счётчик выдаёт
 * занятый номер, и создание падает на уникальном индексе — а виноватой
 * выглядит строка файла, с которой всё в порядке.
 *
 * Считаем по всем карточкам, включая удалённые: индекс про удаление не знает,
 * и номер удалённого клиента остаётся занятым.
 */
export async function syncCustomerCounter(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Tenant" t
       SET "customerNumberNext" = GREATEST(
             t."customerNumberNext",
             COALESCE((SELECT MAX(c."number") + 1 FROM "Customer" c WHERE c."tenantId" = t.id), 1)
           )
     WHERE t.id = ${tenantId}
  `;
}

/** Ошибка уникальности от Prisma — единственная, которую здесь имеет смысл ловить. */
const isTaken = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";

/**
 * Завести клиента с номером — и не упасть, если номер вдруг занят.
 *
 * Занятый номер здесь не исключение, а ожидаемая неприятность: номера
 * приезжают из чужой базы, где своя история. Поэтому сначала пробуем как
 * задумано, а если не вышло — подтягиваем счётчик и берём следующий
 * свободный. Клиент важнее, чем его номер.
 *
 * Пробное создание живёт в своей точке возврата: в PostgreSQL упавшая
 * команда обрывает всю транзакцию, и без точки возврата вторая попытка
 * получила бы «current transaction is aborted» вместо клиента.
 */
export async function createWithNumber<T>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  wanted: number | null,
  create: (number: number) => Promise<T>
): Promise<T> {
  const number =
    wanted !== null ? await reserveCustomerNumber(tx, tenantId, wanted) : await nextCustomerNumber(tx, tenantId);

  await tx.$executeRawUnsafe("SAVEPOINT customer_number");
  try {
    const made = await create(number);
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT customer_number");
    return made;
  } catch (err) {
    if (!isTaken(err)) throw err;
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT customer_number");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT customer_number");

    await syncCustomerCounter(tx, tenantId);
    return create(await nextCustomerNumber(tx, tenantId));
  }
}
