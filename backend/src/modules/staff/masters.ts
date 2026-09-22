import type { Prisma } from "@prisma/client";
import { badRequest } from "../../lib/errors";

/**
 * Кого можно назначить мастером на заказ: сотрудников с ролью «Мастер» и
 * владельца мастерской.
 *
 * Владелец попал сюда не для порядка. В маленькой мастерской он сам и
 * принимает, и чинит, а без него в списке заказы, за которые взялся он,
 * висели «без мастера» — и не находились ни в «Моих заказах», ни в
 * зарплатном отчёте.
 *
 * «Мастер» может быть и не основной ролью: приёмщик, который ещё и чинит,
 * носит её дополнительной. Поэтому сначала находим роли с кодом MASTER, а
 * потом ищем их и в основной роли, и в дополнительных.
 */
async function assignable(tx: Prisma.TransactionClient): Promise<Prisma.UserWhereInput> {
  const masterRoles = await tx.role.findMany({ where: { code: "MASTER" }, select: { id: true } });
  const ids = masterRoles.map((r) => r.id);
  return {
    deletedAt: null,
    isActive: true,
    OR: [
      { roleId: { in: ids } },
      ...(ids.length ? [{ extraRoleIds: { hasSome: ids } }] : []),
      { isOwner: true },
    ],
  };
}

export async function listMasters(tx: Prisma.TransactionClient) {
  const rows = await tx.user.findMany({
    where: await assignable(tx),
    // Владелец — последним: мастеров назначают чаще, и первым в списке
    // должен стоять тот, кого выбирают обычно.
    orderBy: [{ isOwner: "asc" }, { fullName: "asc" }],
    select: { id: true, fullName: true, isOwner: true },
  });
  return rows;
}

/**
 * Проверить назначаемого. Ссылка на пользователя проверяется базой, но
 * внешний ключ не видит построчной защиты: без этой проверки заказ можно
 * было бы назначить сотруднику чужой мастерской, зная его id.
 */
export async function assertAssignable(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const found = await tx.user.findFirst({ where: { id: userId, ...(await assignable(tx)) }, select: { id: true } });
  if (!found) throw badRequest("Этого сотрудника нельзя назначить мастером");
}
