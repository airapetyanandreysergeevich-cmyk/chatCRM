import { withPlatform } from "../lib/db";
import { removeFile } from "../lib/storage";

/**
 * Удаление мастерской насовсем.
 *
 * Отдельным файлом, потому что порядок здесь — не стиль, а условие работы.
 * Связи между таблицами не каскадные: удалить мастерскую одной строкой
 * нельзя, база откажет на первой же ссылке. Значит, удалять надо детей
 * раньше родителей, и один пропущенный шаг оставит мастерскую наполовину
 * стёртой — состояние, из которого нет пути ни назад, ни вперёд.
 *
 * Каскады в схеме мы намеренно не ставим: с ними одна ошибка в коде тихо
 * уносит заказы за собой. Пусть лучше база ругается, а место, где данные
 * действительно можно стирать, будет ровно одно — вот это.
 *
 * Перед строками убираем фотографии: ссылки на них живут только в таблице
 * вложений, и после её очистки файлы стали бы мусором, о котором никто
 * никогда не узнает.
 */

/**
 * Порядок очистки: дети раньше родителей.
 *
 * Список написан руками, а не выведен из схемы: вывести его автоматически
 * заманчиво, но тогда добавление таблицы молча меняло бы порядок удаления —
 * и узнали бы мы об этом в тот единственный раз, когда мастерскую удаляют.
 */
const ORDER: readonly string[] = [
  // висят на всём подряд
  "pushSubscription",
  "notification",
  "auditLog",
  "feedback",
  // деньги
  "transaction",
  "transactionCategory",
  "cashRegister",
  // склад
  "stockMovement",
  "stockBalance",
  "stockItem",
  "warehouse",
  // закупки (позиции ссылаются на заявку)
  "purchaseRequestItem",
  "purchaseRequest",
  // вложения ссылаются и на заказ, и на заявку — значит, после обеих
  "attachment",
  // заказы и всё, что к ним пришито (фото сообщений ушли вместе с вложениями)
  "orderMessage",
  "orderPart",
  "orderWork",
  "orderStatusHistory",
  "order",
  // справочники мастерской
  "deviceHint",
  "quickPick",
  "service",
  "orderStatus",
  "device",
  "customer",
  // сотрудники: на них ссылались заказы, работы, движения — только теперь
  "user",
  "role",
  "branch",
];

export interface Removed {
  files: number;
  rows: Record<string, number>;
}

export async function removeTenantForever(tenantId: string): Promise<Removed> {
  // 1. Фотографии. Сначала список — потом удаление из хранилища, и только
  //    потом строки: если оборвётся на середине, ссылки ещё на месте и
  //    попытку можно повторить.
  const keys = await withPlatform((tx) =>
    tx.attachment.findMany({ where: { tenantId }, select: { objectKey: true } })
  );

  let files = 0;
  for (const { objectKey } of keys) {
    try {
      await removeFile(objectKey);
      files++;
    } catch {
      // Файла может уже не быть — это не повод останавливать удаление
      // мастерской, которую человек удаляет осознанно.
    }
  }

  // 2. Строки.
  const rows: Record<string, number> = {};
  await withPlatform(async (tx) => {
    const client = tx as unknown as Record<string, { deleteMany: (a: unknown) => Promise<{ count: number }> }>;
    for (const table of ORDER) {
      const { count } = await client[table].deleteMany({ where: { tenantId } });
      if (count) rows[table] = count;
    }

    // Записи, которые ссылаются на мастерскую снаружи её данных: сессии,
    // заявка на регистрацию, история входов платформы. Их нельзя оставить —
    // на них держится сама строка Tenant.
    const sessions = await tx.session.deleteMany({ where: { tenantId } });
    if (sessions.count) rows.session = sessions.count;
    const applications = await tx.tenantApplication.updateMany({
      where: { tenantId },
      data: { tenantId: null },
    });
    if (applications.count) rows.tenantApplication = applications.count;
    const impersonations = await tx.impersonation.deleteMany({ where: { tenantId } });
    if (impersonations.count) rows.impersonation = impersonations.count;

    await tx.tenant.delete({ where: { id: tenantId } });
  });

  return { files, rows };
}
